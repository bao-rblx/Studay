# Live demo script (Session 20)

1. Five minutes before: open the live URL (wakes Render) and `/api/health`
   (must say `"db":"up"`; if not, restore the Supabase project).
2. Clean clone on a laptop that never had the project:
   `git clone ... && cd Studay && docker compose up --build`.
3. Show the gate: open the prepared PR from branch `demo/failing-test`,
   show the red `test` check and the disabled merge button.
4. Fix it, push, wait for green, get the review, merge.
5. Show the Actions run: `deploy` job triggers Render, then the change on the live URL.
6. Search the repo for secrets in front of the room: GitHub search for
   `AIza`, `postgres://`, `GEMINI_API_KEY=`; show the green `gitleaks` check.
