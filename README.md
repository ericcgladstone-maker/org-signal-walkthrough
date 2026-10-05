# Analyzing Social Network Data

*An interactive walkthrough using Org Signal, a browser-based environment I built for social network analysis*

Eric Gladstone · teaching walkthrough · October 2026.

A narrated walkthrough of doing social network analysis in [Org Signal](https://orgsignal.graystoneindustries.co), the browser-based environment I built for teaching and conducting network analysis. The software runs on the left, replaying each step of the analysis with a cursor, highlights and zooms. The narration on the right explains what is being done, why, and what it does and does not license. It runs about 82 minutes at 1×: an opening, then eleven chapters, each posed as a question:

1. Who matters in a network, and in what sense?
2. Why does the software's number differ from a hand calculation?
3. What does one person's network look like: closed or brokering?
4. How do you survey a whole group, and what is a tie when two people disagree?
5. Where does a network come from when nobody drew it?
6. What is a tie, really?
7. Who are the brokers, and how sure can we be?
8. Is this organization siloed, and since when?
9. Can structure anticipate how a group splits?
10. Do people see their own network accurately?
11. How do you get from an analysis to a claim you can defend?

The organizations and people in the generated data are fictional, as are the students, the interview respondent and the worked examples. The classic datasets (Zachary's karate club, Krackhardt's high-tech managers) are published studies, cited where they appear.

- **Live:** https://orgsignalwalkthrough.eric-c-gladstone.workers.dev
- **Also at:** https://graystoneindustries.co/talks/ (embedded)
- **Org Signal:** https://orgsignal.graystoneindustries.co · source at https://github.com/ericcgladstone-maker/org-signal

## Use

Press play, or step through the passages with ‹ › (or the `,` and `.` keys). The chapter menu jumps to any question. Expand fills the screen and keeps the current passage as a caption. Reduced-motion settings show each step settled. `?embed=1` hides the page header and the full text so the player can sit inside a frame. Each chapter links to the place in Org Signal where the same step can be repeated.

Run locally with any static server that serves `public/`, for example `python3 -m http.server 8975 --directory public`. Serving it with the security headers in `public/_headers` matches the published version.

## How it works

The left side is not a video. `public/app/` is a frozen copy of Org Signal (the commit is in `public/app/VERSION`), and `public/stage/` drives it: each passage of the narration has one stage step, a short script of real clicks, selections and loads on the app, with the cursor, highlights and zooms drawn over it. Seeking to any passage replays the steps before it instantly, so every passage always shows the same screen. Every number spoken in the narration is one shown on screen at that step; the build checks this.

`public/`:
- `index.html`, the player (`player.js`, `player.css`, `embed.js`) and the timed narration (`timeline.js`);
- `stage/`, the stage and its scene scripts (`stage/scenes/`, one file per chapter);
- `app/`, the frozen Org Signal build.

It makes no third-party requests. Everything, including the synthetic data, is generated in the browser from fixed seeds.

`sync.sh` copies the site from the working project into `public/`. Deploy with `npx wrangler deploy`.
