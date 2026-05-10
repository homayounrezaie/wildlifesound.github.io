#!/usr/bin/env python3
"""Small local HTTP bridge for NatureLM-audio.

Run this in a Python environment where NatureLM-audio is installed and where
Hugging Face access to the required Llama checkpoint is already configured.
"""

from __future__ import annotations

import base64
import json
import os
import re
import tempfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse


def load_env_file(file_path: Path) -> None:
    if not file_path.exists():
        return

    for raw_line in file_path.read_text(encoding="utf-8").splitlines():
        match = re.match(r"^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$", raw_line)
        if not match:
            continue
        key, value = match.groups()
        if key in os.environ:
            continue
        os.environ[key] = value.strip().strip("\"'")


load_env_file(Path(__file__).resolve().parent / ".env.local")
if os.environ.get("HF_TOKEN") and not os.environ.get("HUGGING_FACE_HUB_TOKEN"):
    os.environ["HUGGING_FACE_HUB_TOKEN"] = os.environ["HF_TOKEN"]


HOST = os.environ.get("NATURELM_HOST", "127.0.0.1")
PORT = int(os.environ.get("NATURELM_PORT", "8787"))
MODEL_ID = os.environ.get("NATURELM_MODEL_ID", "EarthSpeciesProject/NatureLM-audio")
DEVICE = os.environ.get("NATURELM_DEVICE", "cuda")
WINDOW_SECONDS = float(os.environ.get("NATURELM_WINDOW_SECONDS", "10.0"))
HOP_SECONDS = float(os.environ.get("NATURELM_HOP_SECONDS", "10.0"))
DEFAULT_QUERY = "What is the common name for the focal species in the audio? Answer:"

MODEL = None
PIPELINE = None


def load_pipeline():
    global MODEL, PIPELINE
    if PIPELINE is not None:
        return PIPELINE

    try:
        from NatureLM.models import NatureLM
    except ImportError:
        from NatureLM.models.NatureLM import NatureLM
    from NatureLM.infer import Pipeline

    MODEL = NatureLM.from_pretrained(MODEL_ID)
    MODEL = MODEL.eval().to(DEVICE)
    PIPELINE = Pipeline(model=MODEL)
    return PIPELINE


def suffix_for_mime(mime_type: str) -> str:
    mime_type = (mime_type or "").split(";")[0].lower()
    return {
        "audio/mpeg": ".mp3",
        "audio/mp3": ".mp3",
        "audio/wav": ".wav",
        "audio/x-wav": ".wav",
        "audio/webm": ".webm",
        "audio/ogg": ".ogg",
        "audio/flac": ".flac",
        "audio/mp4": ".m4a",
    }.get(mime_type, ".wav")


def clean_label(label: str) -> str:
    label = re.sub(r"#?\d+(?:\.\d+)?s?\s*[-–]\s*\d+(?:\.\d+)?s?#?:", "", label)
    label = re.sub(r"^(answer|species|common name)\s*:\s*", "", label, flags=re.I)
    label = label.strip(" \t\r\n\"'`.,;:")
    return re.sub(r"\s+", " ", label)


def species_from_results(results: list[str]) -> list[dict]:
    seen: set[str] = set()
    species: list[dict] = []
    for raw in results:
        for line in str(raw).splitlines():
            common_name = clean_label(line)
            if not common_name or common_name.lower() in {"none", "unknown", "no species", "no animal"}:
                continue
            key = common_name.lower()
            if key in seen:
                continue
            seen.add(key)
            species.append({
                "common_name": common_name,
                "scientific_name": "",
                "confidence": "medium",
                "probability_score": 60,
                "sound_description": "NatureLM-audio identified this as the focal species.",
            })
    return species


class NatureLMHandler(BaseHTTPRequestHandler):
    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
        self.end_headers()

    def do_POST(self):
        if urlparse(self.path).path != "/analyze":
            self.send_json({"error": {"message": "Not found"}}, 404)
            return

        try:
            length = int(self.headers.get("content-length", "0"))
            payload = json.loads(self.rfile.read(length) or b"{}")
            audio_base64 = payload.get("audio_base64", "")
            if not audio_base64:
                self.send_json({"error": {"message": "audio_base64 is required"}}, 400)
                return

            audio_bytes = base64.b64decode(audio_base64)
            query = payload.get("query") or DEFAULT_QUERY
            suffix = suffix_for_mime(payload.get("mime_type", "audio/wav"))

            with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
                tmp.write(audio_bytes)
                audio_path = Path(tmp.name)

            try:
                pipeline = load_pipeline()
                results = pipeline(
                    [str(audio_path)],
                    [query],
                    window_length_seconds=WINDOW_SECONDS,
                    hop_length_seconds=HOP_SECONDS,
                )
            finally:
                audio_path.unlink(missing_ok=True)

            self.send_json({
                "model": "NatureLM-audio",
                "raw_text": "\n".join(map(str, results)),
                "species": species_from_results(results),
            })
        except Exception as exc:
            self.send_json({"error": {"message": str(exc)}}, 500)

    def send_json(self, payload: dict, status: int = 200):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        print(f"NatureLM {self.address_string()} - {fmt % args}")


if __name__ == "__main__":
    server = ThreadingHTTPServer((HOST, PORT), NatureLMHandler)
    print(f"NatureLM bridge running at http://{HOST}:{PORT}/analyze")
    server.serve_forever()
