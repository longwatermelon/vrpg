# vrpg

AI-generated RPG: an LLM (via OpenRouter) runs the story as branching choices, Minimax H3 Max (via Fal) renders each chosen action as a 5-15s third-person clip (length picked by the LLM) continuing from the last frame of the previous clip. The player controls one character, described by appearance in prompts like any other character in the scene. See spec.md for details.

Run with `npm start` (needs `.env` with `FAL_API_KEY` and `OPENROUTER_API_KEY`, plus `ffmpeg` on PATH), then open http://localhost:3000. Describe your character and starting scenario, wait for the opening frame, then pick choices as clips render. Session media lands in `data/<timestamp>/`; one in-memory session at a time, server restart loses the story.

Cost: ~$0.13 per 5s of clip (480p), LLM cost negligible.
