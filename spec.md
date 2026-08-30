# VRPG

`vrpg` is a program which offers an AI-generated RPG game experience, with an LLM running the actual story and a video model rendering the graphics and an image model for generating keyframes to feed to the video model.

The story is text-first; it's essentially an LLM chat except each LLM response also includes a json object that describes the clip which should be rendered alongside that response to continue the story. The player never reads the LLM chat; the game is purely video from their perspective, so the clips generated must contain all info from the scene the player needs to know.

## Playthrough structure

First, the player is greeted with a textbox in which they describe the basic context or starting point of the story. That context gets sent as the first user message in the LLM chat. Image model generates the starting frame.

At this point, the player enters the main game loop, which consists of the following steps:
  * LLM generates 2-3 options for the player to take in the LLM chat as its response, formatted as json. Options displayed on screen.
  * Player clicks on one option; the label of that choice gets sent to LLM as a user message (ie "Eat the sandwich", "Say: \"What are you doing here?\"", etc).
  * Image model renders end keyframe of the clip for that choice, then video model renders clip starting from current paused frame & ending at image model's generated end keyframe.
    - Note: rendered clip must preserve continuity. Start from the last frame of the previous clip. All characters, settings, objects, etc. should stay consistent.
  * Clip plays once rendered, pauses at its last frame.

## Clip JSON

```json
{
  "choices": [
    {
      "label": "Eat your girlfriend's sandwich",
      "prompt": "You pick up the sandwich from the girl's plate and eat it. She looks at you, annoyed, and says <d>[English] Would you stop eating my food? Ugh...</d>"
    },
    {
      "label": "Get up and leave",
      "prompt": "You stand up, turn around, and walk out of the restaurant. The girl looks confused and says <d>[English] Hey, where are you going!?</d>."
    }
  ]
}
```

A choice is displayed as its `label` field. Clicking that choice sends the `prompt` field sends this prompt to the image model:
  * You are tasked with generating the end keyframe of a video clip from a first-person / camera's pov (referred to as "you"). The image attached is the start keyframe of the clip. The clip will denote the following events transpiring: `(direct copy-paste of the prompt field of the chosen choice, without the parens)`. The clip is five seconds long. Note that the end keyframe DOES NOT necessarily need to recognizably contain the same scene as the start keyframe; the end keyframe DOES NOT NECESSARILY NEED TO ENCODE THE EVENTS THAT TRANSPIRED, it simply must be a concrete last frame of the clip.

Once the image model finishes, use start keyframe = current frozen frame, end keyframe = image model's output, send "First-person POV. `(prompt field, without the parens)`" to video model along with start keyframe and end keyframe. The video it returns is the clip that gets played.

## Models

LLM: accessed via OpenRouter.

Image model: GPT-image-2.
  * Plain run: `codex-run "<image model prompt>. Save the image to <output file path>."`
  * Run with image attachment: `codex-run "The attached image is at <input image path>. <image model prompt>. Save the image to <output file path>."`

Video model: Minimax H3 Max (via Fal AI).

