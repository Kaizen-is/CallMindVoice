"""The bits of src/lib/catalog.ts the backend needs (voices, the per-minute wallet price)."""

# The internal Uzbek TTS server's two named speakers.
VOICES = (
    {"id": "laylo", "name": "Laylo", "gender": "female", "langs": ("uz",), "note": "Warm, unhurried female voice"},
    {
        "id": "isomiddin",
        "name": "Isomiddin",
        "gender": "male",
        "langs": ("uz",),
        "note": "Formal, low-register male voice",
    },
)

# Agents saved before the v2 speaker rename keep working.
LEGACY_VOICE_IDS = {"nilufar": "laylo", "timur": "isomiddin"}

# Prepaid per-minute rates in UZS (so'm).
UZS_RATES = {"realTalkPerMin": 1000, "ttsPerMin": 800, "sttPerMin": 600}
AI_MINUTE_UZS = UZS_RATES["realTalkPerMin"]
