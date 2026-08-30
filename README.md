# vrpg

AI-generated RPG: an LLM (claude sonnet 4.5 via OpenRouter) runs the story as branching choices, Minimax H3 Max (via Fal) renders each chosen action as a 5s first-person POV clip continuing from the last frame of the previous clip. See spec.md for details.

Run with `npm start` (needs `.env` with `FAL_API_KEY` and `OPENROUTER_API_KEY`, plus `ffmpeg` and the `image-gen` cli on PATH), then open http://localhost:3000. Describe your starting scenario, wait for the opening frame, then pick choices as clips render. Session media lands in `data/<timestamp>/`; one in-memory session at a time, server restart loses the story.

Cost: ~$0.13 per clip (480p 5s), LLM cost negligible.
