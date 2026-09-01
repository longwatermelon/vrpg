# VRPG

`vrpg` is a program which offers an AI-generated RPG game experience, with an LLM running the actual story and a video model rendering the graphics.

The story is text-first; it's essentially an LLM chat except the LLM responds with a single json object that describes the branches which can occur next, and the player chooses the branch to go down. The player never reads the LLM chat; the game is purely video from their perspective, so the clips generated must contain all info from the scene the player needs to know.

The player controls one character in the story, described by them at the start. Prompts refer to that character by appearance like any other character in the scene; nothing is privileged about them except that the player picks their actions. (First-person POV prompts were tried and consistently confused the image/video models.)

## Playthrough structure

First, the player fills in two textboxes: a description of the character they'll control, and the basic context or starting point of the story. A setup LLM call fleshes the character description into a concrete visual description (what a camera can see, no name or backstory) and writes the opening frame prompt: a third-person shot of the starting scene with the player character in it. That prompt is used by an image model to generate the starting frame (Seedream 4.5 via Fal), which will be fed to the story LLM as an attachment on the first user message. The fleshed-out character description goes into the story LLM's system prompt so every clip prompt can re-describe the character consistently.

The static opening frame normally stays hidden: the start call waits until the frame's 5s idle loop is also rendered, and the client puts that loop on stage together with the first choices — so the first thing the player sees is the scene already in motion, without the story being advanced for them. The frame is shown only if the loop cannot render or play. From there the player is in the main game loop, which consists of the following steps:
  * LLM generates 2-3 options for the player to take in the LLM chat as its response, formatted as json. Options displayed on screen.
  * Player clicks on one option; the label of that choice gets inserted into the user message (ie "Eat the sandwich", "Say: \"What are you doing here?\"", etc).
  * Video model renders clip starting from current paused frame.
    - Note: rendered clip must preserve continuity. Start from the last frame of the previous clip. All characters, settings, objects, etc. should stay consistent.
    - The clip is delivered and starts playing the moment it's rendered; everything else happens behind it. The chosen option's baked-in `loop-prompt` kicks off a 5s idle loop render of the clip's last frame immediately, and in parallel the next-choices LLM call runs. Clips are a minimum of 8s, so both usually finish behind the playback.
    - The loop plays on repeat from the moment it's rendered (the clip's frozen last frame stands until then), through the next render wait. When the next clip is ready, the current loop cycle finishes first — the loop ends on its start keyframe, which is also the clip's start keyframe — so the cut is seamless. The loop is best-effort: if its render fails, the static frame stands.
  * Clip plays once rendered, pauses at its last frame. If the next choices aren't written yet when the clip ends, a spinner ("Thinking about next choices...") shows until they land; if that LLM call fails, a Retry button re-runs it against the already-rendered clip. Attach the last frame of that clip to the user message.

So the user message is structured as `Choose option: <option label>\nAttached image is the last frame of where this chosen action left off.` with the frozen frame attached as an image. The LLM reads this and decides what options come next.

## Clip JSON

```json
{
  "choices": [
    {
      "label": "Eat your girlfriend's sandwich",
      "prompt": "The man in the gray hoodie sitting at the table picks up the half-eaten sandwich from the woman's plate and eats it. A crunch sound plays as the sandwich is consumed. She glares at him, annoyed, and says <d>[English] Would you stop eating my food? Ugh...</d>. End state: the sandwich is completely gone from her plate and she sits glaring at the man in the gray hoodie.",
      "duration": 8,
      "loop-prompt": "The man in the gray hoodie sits at the restaurant table chewing slowly, avoiding eye contact with the woman across from him, who glares at him with her arms crossed. The camera stays still and both end back exactly at their starting poses."
    },
    {
      "label": "Call the waiter over",
      "prompt": "The man in the gray hoodie sitting at the table raises his hand, and a middle-aged man in a white apron (currently off-screen) walks into view and stops beside the table, saying <d>[English] What can I get you?</d>. End state: the man in the white apron stands beside the table holding a notepad, the woman watching him.".,
      "duration": 8,
      "loop-prompt": "The middle-aged man in the white apron stands beside the table holding a notepad, pen ready; the man in the gray hoodie glances over the menu while the woman across from him watches the waiter. The camera stays still and everyone ends back exactly at their starting poses."
    }
  ]
}
```

Use start keyframe = current frozen frame, send the prompt field directly to the video model along with the start keyframe; nothing is prepended. The `duration` field is the clip length in seconds, chosen by the LLM as an integer 8-15 and passed straight to the video model. The video it returns is the clip that gets played; extract the last frame of the video as the current frozen frame.

Each choice carries its own `loop-prompt`, written by the story LLM alongside the clip prompt from that choice's intended end state (no extra LLM call sits ahead of the loop render). It describes a 5s idle animation of the frame the clip ends on (the one the choices are offered on): camera roughly still, characters doing subtle believable idle motion, ending back exactly at the start pose so it loops seamlessly. The moment the chosen clip renders and its last frame is extracted, the loop render starts with duration 5 and that frame as both start keyframe and `end_image_url`, forcing the loop closed. Neither the loop nor the choices block the clip: the loop goes on stage whenever its render finishes, and the choices appear whenever their call finishes — the two are independent. The opening turn is the exception: its loop prompt still comes from its own quick LLM call (same transcript plus the opening frame, reasoning forced off — effort `none` when the model allows it, model default otherwise), since no choice describes the opening frame and the start is allowed to be slow — the start call returns once its loop is rendered, and the client stages the loop with the first choices (the static frame is only a failure fallback).

## Custom actions

Besides the 2-3 offered choices, the player can type their own idea into a fourth box. An extra LLM call (same transcript plus the current frame) takes *inspiration* from the idea and writes one concrete choice (label, prompt, duration, loop-prompt) following the normal prompt rules; the turn then proceeds exactly like a preset choice, with `Choose custom action: <label>` as the user message.

## Timeline

A left sidebar (toggle pill top-left; it overlays the dev pill, and holds the cost tracker and restart button at its bottom) lists every turn of the story as a point: frame thumbnail plus the label of the choice taken there. The session tracks a viewing position `pos` alongside the tip `turn`; everything is reconstructed from the transcript and the on-disk `frame-N`/`clip-N`/`loop-N` files, so browsing is free. Clicking a point seeks to it (its frame and saved idle loop go on stage); at any position before the tip the only option is a single Continue button that replays the canonical `clip-pos` and steps forward. Choices are only live at the tip. Each non-tip point offers "delete everything after this": the transcript is truncated after that turn's assistant message (its original choices re-parsed from it and offered again), later frames/clips/loops and the stitched `story.mp4` are deleted, and that turn becomes the live tip — this is how you branch the story. Saved stories always resume at the tip.

## Saved stories

Every committed turn writes `session.json` into the story's `data/<id>/` dir: the full LLM transcript (images stripped, the frames live on disk), current choices, prompts, and turn state. The start screen lists all story dirs found in `data/`, each shown with its last frame as thumbnail. A story with a `session.json` can be resumed: the server loads it as the active session and the player continues from the last frame (reusing the already-rendered idle loop for that frame if present). Render stitches the story's main clips (`clip-*.mp4`, loops excluded) into one `story.mp4` via ffmpeg re-encode and the browser downloads it; the result is cached until a newer clip lands. A second option, Render + Choices, produces `story-choices.mp4`: the same stitched video, but each turn's options UI (reconstructed from the transcript) is overlaid over the start of its clip — shown as during play for a second, then the option actually picked highlights green while the rest fade out, holds ~2 seconds, and fades out too, with the video playing underneath the whole time. A custom action shows its generated label as an extra picked option. Delete removes the story dir permanently (refused while that story is being played).

## Models

LLM: accessed via OpenRouter.

Video model: Minimax H3 Max (via Fal AI).
  * 480p with `balanced` prompt expansion mode

Starting frame image model: Bytedance Seedream 4.5 (via Fal AI).
