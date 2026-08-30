# VRPG

`vrpg` is a program which offers an AI-generated RPG game experience, with an LLM running the actual story and a video model rendering the graphics.

The story is text-first; it's essentially an LLM chat except the LLM responds with a single json object that describes the branches which can occur next, and the player chooses the branch to go down. The player never reads the LLM chat; the game is purely video from their perspective, so the clips generated must contain all info from the scene the player needs to know.

The player controls one character in the story, described by them at the start. Prompts refer to that character by appearance like any other character in the scene; nothing is privileged about them except that the player picks their actions. (First-person POV prompts were tried and consistently confused the image/video models.)

## Playthrough structure

First, the player fills in two textboxes: a description of the character they'll control, and the basic context or starting point of the story. A setup LLM call fleshes the character description into a concrete visual description (what a camera can see, no name or backstory) and writes the opening frame prompt: a third-person shot of the starting scene with the player character in it. That prompt is used by an image model to generate the starting frame (Seedream 4.5 via Fal), which will be fed to the story LLM as an attachment on the first user message. The fleshed-out character description goes into the story LLM's system prompt so every clip prompt can re-describe the character consistently.

At this point, the player enters the main game loop, which consists of the following steps:
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
      "prompt": "Start context: a tall young man with short brown hair in a gray hoodie sits at a restaurant table, a young woman seated across from him with a sandwich on her plate. Action: the man in the gray hoodie picks up the sandwich from the woman's plate and eats it. A crunch sound plays as the sandwich is consumed. She glares at him, annoyed, and says <d>[English] Would you stop eating my food? Ugh...</d>. End state: the sandwich is completely gone from the woman's plate and she sits glaring at the man.",
      "duration": 8
    },
    {
      "label": "Get up and leave",
      "prompt": "Start context: a tall young man with short brown hair in a gray hoodie sits at a restaurant table, a young woman seated across from him. Action: the man in the gray hoodie rises from the table and walks out of the restaurant. The woman looks confused and says <d>[English] Hey, where are you going!?</d>.",
      "duration": 6
    }
  ],
  "loop-prompt": "A tall young man with short brown hair in a gray hoodie and a young woman sit facing each other at a restaurant table. The camera stays still. They idle in place, breathing softly and glancing around. By the end both have returned exactly to their starting poses."
}
```

Use start keyframe = current frozen frame, send the prompt field directly to the video model along with the start keyframe; nothing is prepended. The `duration` field is the clip length in seconds, chosen by the LLM as an integer 5-15 (5 for a short one-shot action, 7-12 default, 15 for dialogue/fights/explanations) and passed straight to the video model. The video it returns is the clip that gets played; extract the last frame of the video as the current frozen frame.

The top-level `loop-prompt` field describes a 5s idle animation of the current frame (the one the choices are offered on): camera roughly still, characters doing subtle believable idle motion, ending back exactly at the start pose so it loops seamlessly. It renders with duration 5 and the current frame as both start keyframe and `end_image_url`, forcing the loop closed. The choose turn only returns once both the main clip and this loop are rendered, so the loop is guaranteed ready when the clip finishes playing. The opening turn's loop is the exception: it renders in the background and pops in when ready, so game start isn't delayed.

## Models

LLM: accessed via OpenRouter.

Video model: Minimax H3 Max (via Fal AI).
  * 480p with `disabled` prompt expansion mode

Starting frame image model: Bytedance Seedream 4.5 (via Fal AI).
