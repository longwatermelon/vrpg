# VRPG

`vrpg` is a program which offers an AI-generated RPG game experience, with an LLM running the actual story and a video model rendering the graphics.

The story is text-first; it's essentially an LLM chat except the LLM responds with a single json object that describes the branches which can occur next, and the player chooses the branch to go down. The player never reads the LLM chat; the game is purely video from their perspective, so the clips generated must contain all info from the scene the player needs to know.

The player controls one character in the story, described by them at the start. Prompts refer to that character by appearance like any other character in the scene; nothing is privileged about them except that the player picks their actions. (First-person POV prompts were tried and consistently confused the image/video models.)

## Playthrough structure

First, the player fills in two textboxes: a description of the character they'll control, and the basic context or starting point of the story. A setup LLM call fleshes the character description into a concrete visual description (what a camera can see, no name or backstory) and writes the opening frame prompt: a third-person shot of the starting scene with the player character in it. That prompt is used by an image model to generate the starting frame (Seedream 4.5 via Fal), which will be fed to the story LLM as an attachment on the first user message. The fleshed-out character description goes into the story LLM's system prompt so every clip prompt can re-describe the character consistently.

The static opening frame normally stays hidden: the start call waits until the frame's 5s idle loop (from the opening turn's `loop-prompt`) is also rendered, and the client puts that loop on stage together with the first choices — so the first thing the player sees is the scene already in motion, without the story being advanced for them. The frame is shown only if the loop cannot render or play. From there the player is in the main game loop, which consists of the following steps:
  * LLM generates 2-3 options for the player to take in the LLM chat as its response, formatted as json. Options displayed on screen.
  * Player clicks on one option; the label of that choice gets inserted into the user message (ie "Eat the sandwich", "Say: \"What are you doing here?\"", etc).
  * Video model renders clip starting from current paused frame.
    - Note: rendered clip must preserve continuity. Start from the last frame of the previous clip. All characters, settings, objects, etc. should stay consistent.
    - After the clip renders, a 5s idle loop of its last frame is also rendered (from the new turn's top-level `loop-prompt`) and the turn isn't returned until both are done — seamlessness over latency. The loop plays on repeat from the moment the clip ends and the options are up, through the next render wait. When the next clip is ready, the current loop cycle finishes first — the loop ends on its start keyframe, which is also the clip's start keyframe — so the cut is seamless. The loop is best-effort: if its render fails, the static frame stands.
  * Clip plays once rendered, pauses at its last frame. Attach the last frame of that clip to the user message.

So the user message is structured as `Choose option: <option label>\nAttached image is the last frame of where this chosen action left off.` with the frozen frame attached as an image. The LLM reads this and decides what options come next.

## Clip JSON

```json
{
  "choices": [
    {
      "label": "Eat your girlfriend's sandwich",
      "prompt": "The man in the gray hoodie sitting at the table picks up the half-eaten sandwich from the woman's plate and eats it. A crunch sound plays as the sandwich is consumed. She glares at him, annoyed, and says <d>[English] Would you stop eating my food? Ugh...</d>. End state: the sandwich is completely gone from her plate and she sits glaring at the man in the gray hoodie.",
      "duration": 8
    },
    {
      "label": "Call the waiter over",
      "prompt": "The man in the gray hoodie sitting at the table raises his hand, and a middle-aged man in a white apron (currently off-screen) walks into view and stops beside the table, saying <d>[English] What can I get you?</d>. End state: the man in the white apron stands beside the table holding a notepad, the woman watching him.".,
      "duration": 8
    }
  ],
  "loop-prompt": "A tall young man with short brown hair in a gray hoodie and a young woman sit facing each other at a restaurant table. The camera stays still. They idle in place, breathing softly and glancing around. By the end both have returned exactly to their starting poses."
}
```

Use start keyframe = current frozen frame, send the prompt field directly to the video model along with the start keyframe; nothing is prepended. The `duration` field is the clip length in seconds, chosen by the LLM as an integer 5-15 (5 for a short one-shot action, 7-12 default, 15 for dialogue/fights/explanations) and passed straight to the video model. The video it returns is the clip that gets played; extract the last frame of the video as the current frozen frame.

The top-level `loop-prompt` field describes a 5s idle animation of the current frame (the one the choices are offered on): camera roughly still, characters doing subtle believable idle motion, ending back exactly at the start pose so it loops seamlessly. It renders with duration 5 and the current frame as both start keyframe and `end_image_url`, forcing the loop closed. The choose turn only returns once both the main clip and this loop are rendered, so the loop is guaranteed ready when the clip finishes playing. The opening turn waits the same way: the start call only returns once its loop is rendered, and the client stages the loop with the first choices (the static frame is only a failure fallback).

## Saved stories

Every committed turn writes `session.json` into the story's `data/<id>/` dir: the full LLM transcript (images stripped, the frames live on disk), current choices, prompts, and turn state. The start screen lists all story dirs found in `data/`, each shown with its last frame as thumbnail. A story with a `session.json` can be resumed: the server loads it as the active session and the player continues from the last frame (reusing the already-rendered idle loop for that frame if present). Render stitches the story's main clips (`clip-*.mp4`, loops excluded) into one `story.mp4` via ffmpeg re-encode and the browser downloads it; the result is cached until a newer clip lands. Delete removes the story dir permanently (refused while that story is being played).

## Models

LLM: accessed via OpenRouter.

Video model: Minimax H3 Max (via Fal AI).
  * 480p with `balanced` prompt expansion mode

Starting frame image model: Bytedance Seedream 4.5 (via Fal AI).
