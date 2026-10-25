# ROOMMATE (alpha)

Tiny prototype: a 3D room (Three.js) where two players walk around with WASD and watch a synced YouTube video on a TV. Multiplayer via Socket.IO.

## Run locally

Requires Node.js.

    npm install
    npm start

Open http://localhost:3000 in two browser windows, join the same room code, and paste a YouTube link.

## Notes

- Needs a running Node server (GitHub Pages won't work). Deploy to Render, Railway, or Fly.io to play online.
- Play/pause is synced through YouTube's own controls on the TV.
