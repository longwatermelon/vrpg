# VRPG

`vrpg` is a program which offers an AI-generated RPG game experience, with an LLM running the actual story and a video model rendering the graphics.

The story is text-first; it's essentially an LLM chat except the LLM responds with a single json object that describes the branches which can occur next, and the player chooses the branch to go down. The player never reads the LLM chat; the game is purely video from their perspective, so the clips generated must contain all info from the scene the player needs to know.

## Playthrough structure

First, the player is greeted with a textbox in which they describe the basic context or starting point of the story. That context gets sent as the first user message in the LLM chat. Use an image model to generate the starting frame (tbd which one), which will be fed to the LLM as an attachment on the first user message.

At this point, the player enters the main game loop, which consists of the following steps:
  * LLM generates 2-3 options for the player to take in the LLM chat as its response, formatted as json. Options displayed on screen.
  * Player clicks on one option; the label of that choice gets inserted into the user message (ie "Eat the sandwich", "Say: \"What are you doing here?\"", etc).
  * Video model renders clip starting from current paused frame.
    - Note: rendered clip must preserve continuity. Start from the last frame of the previous clip. All characters, settings, objects, etc. should stay consistent.
  * Clip plays once rendered, pauses at its last frame. Attach the last frame of that clip to the user message.

So the user message is structured as `Choose option: <option label>\nAttached image is the last frame of where this chosen action left off.` with the frozen frame attached as an image. The LLM reads this and decides what options come next.

## Clip JSON

```json
{
  "choices": [
    {
      "label": "Eat your girlfriend's sandwich",
      "prompt": "You pick up the sandwich from the girl's plate and eat it. A crunch sound plays as the sandwich is consumed. She looks at you, annoyed, and says <d>[English] Would you stop eating my food? Ugh...</d>. In the end, the sandwich is completely gone from the girl's plate, the girl is looking annoyed at the camera, and the sandwich is fully consumed."
    },
    {
      "label": "Get up and leave",
      "prompt": "You stand up, turn around, and walk out of the restaurant. The girl looks confused and says <d>[English] Hey, where are you going!?</d>."
    }
  ]
}
```

Use start keyframe = current frozen frame, send prompt "First-person POV. `(prompt field)`" to video model along with start keyframe. The video it returns is the clip that gets played; extract the last frame of the video as the current frozen frame.

## Models

LLM: accessed via OpenRouter.

Video model: Minimax H3 Max (via Fal AI).
  * 480p with `balanced` prompt expansion mode

