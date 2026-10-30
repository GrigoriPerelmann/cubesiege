# Cube Siege

A top-down **co-op survival shooter** for the browser. 1–8 blocky survivors hold out
against endless waves of undead, chain kills for score multipliers, unlock a growing
arsenal and build defenses.

There is **no server to run and no port forwarding**: the player who creates a room runs the
game in their browser, and friends connect to it directly peer-to-peer (WebRTC via
[PeerJS](https://peerjs.com)). The public PeerJS broker `0.peerjs.com` only introduces the
browsers to each other.

## Quick start

1. Open **`cube-siege.html`** in a browser (double-click works). Every player needs this file:
   send it to your friends, or upload it to any free static host (GitHub Pages, Netlify Drop,
   itch.io…) and share that link.
2. One player types a name, picks a map and clicks **Create room**.
3. The others enter the **4-letter room code** and click **Join**. If the file is hosted on a
   website, the lobby also shows an invite link that joins automatically.
4. The host clicks **Start game**. Players can also drop into a running game and spawn at the
   next wave break.

Notes:
* An internet connection is needed (for the PeerJS library, the broker and the fonts).
* The host's browser runs the game. **The host must keep the tab open** until the round is
  over. It keeps running in the background if the host switches windows.
* Peer-to-peer works on almost all home networks. Very strict firewalls (some corporate or
  university networks) can block it, and the join will then time out with a message.

## Controls

Play with the **keyboard only**, or keyboard + mouse. The game switches automatically:
pressing Space selects keyboard aiming, and moving or clicking the mouse selects mouse aiming.

| Action | Keyboard only | With mouse |
|---|---|---|
| Move | `W A S D` or arrow keys | `W A S D` or arrow keys |
| Aim | you face the way you last moved; aim-assist locks onto an enemy close to that direction (red brackets) | mouse |
| Shoot / place | hold `Space` | hold left button |
| Select weapon | `1`–`9`, `0` | `1`–`9`, `0` |
| Previous / next weapon | `Q` / `E` | `Q` / `E` or mouse wheel |
| Chat | `Enter` | `Enter` |
| Scoreboard | hold `Tab` | hold `Tab` |
| Mute sound | `M` | `M` |

## How a round works

* **Waves**: each wave sends more enemies, and later waves add tougher types. Every 5th wave
  brings a **Colossus** boss. There is a 9 second break between waves.
* **Combo multiplier**: each kill within 2.6 s of your previous kill extends your chain. Every
  4 chained kills raise your multiplier (up to **x10**), and kill points are multiplied by it.
* **Unlocks**: all kill points go into the **team score**. Reaching a threshold unlocks the next
  weapon for everyone, with half a load of ammo. The bar above the weapon slots shows progress.
* **Pickups**: enemies sometimes drop **ammo crates** (refill every unlocked weapon a bit) and
  **med-kits** (+35 HP). Two extra crates appear at every wave break.
* **Downed & revive**: at 0 HP you go down and bleed out after 25 s. A teammate who stands next
  to you for 2.5 s revives you (several helpers revive faster). If you bleed out, you respawn
  when the wave is cleared.
* **Game over**: when no survivor is left standing. Playing solo, going down ends the game.

## Arsenal

| # | Weapon | Unlocks at | Notes |
|---|---|---|---|
| 1 | Pistol | start | Infinite ammo, accurate |
| 2 | SMG | 400 | Very fast, wide spread |
| 3 | Shotgun | 1,300 | 8 pellets, close range |
| 4 | Barricade | 2,600 | Places a wooden block (450 HP). Blocks enemies and players, not bullets |
| 5 | Assault Rifle | 4,500 | Fast, accurate, long range |
| 6 | Mines | 7,000 | Dropped at your feet, big blast when an enemy steps on them |
| 7 | Railgun | 10,500 | Pierces every enemy in a line |
| 8 | Flamethrower | 15,000 | Short cone, sets enemies on fire |
| 9 | Rocket Launcher | 21,000 | Large explosion |
| 0 | Sentry Gun | 28,000 | Auto-turret, lasts 60 s or 260 shots |

There is no friendly fire and you can't hurt yourself with explosives, so fire freely.

## Enemies

| Enemy | First wave | Behaviour |
|---|---|---|
| **Shambler** | 1 | Slow, green and numerous. The backbone of every horde |
| **Sprinter** | 2 | Pale and fragile, but twice as fast |
| **Warlock** | 3 | Horned caster. Keeps its distance and lobs fireballs that also wreck barricades |
| **Brute** | 4 | Huge and slow, with lots of health. Hard to knock back |
| **Bloater** | 6 | Explodes when it reaches you or dies. The blast also hurts other undead |
| **Colossus** | 5, 10, 15… | Boss. Fires rings of fireballs and summons minions. Health scales with player count |

Enemy health grows about 11% per wave. Enemy count scales with the number of players.
Enemies path around walls with a flow field and smash through barricades when those block the shortest route.

## Maps

* **Rust Depot**: open warehouse yard, crate stacks and L-shaped cover, four gates.
* **Crossroads**: town streets around a central square, with long sight lines.
* **Bunker 9**: nine concrete rooms joined by narrow doors. Chokepoint heaven.
* **Dusk Orchard**: fenced orchard at sunset, full of trees, with gates on every side.

Maps are generated by small functions in `public/js/sim.js`. Add a `make*` function and
an entry in `MAPS`/`THEMES` to create your own. Tile legend: `#` wall, `B` crate,
`T` tree/pillar, `.`/`,` floor, `S` enemy spawn, `P` player spawn.

## How it works

```
cube-siege.html     the whole game in one file (generated by build.py)
build.py            bundles public/ into cube-siege.html
public/index.html   menu, lobby and results screens
public/js/main.js   UI flow, PeerJS hosting/joining, frame loop
public/js/host.js   the room "server" running in the host's browser (lobby, 30 Hz game loop)
public/js/sim.js    authoritative simulation: maps, enemies, AI, weapons, waves, score
public/js/game.js   client game: interpolation, movement prediction, input, effects, HUD
public/js/render.js canvas renderer: pseudo-3D blocks, characters, lighting
public/js/audio.js  procedural WebAudio sound effects
```

* The **host's browser is authoritative** for enemies, hits, damage, pickups and score. It sends
  snapshots to every peer at 15 Hz (about 5–15 KB/s per player), so the host's upload speed
  matters a little with 6–8 players.
* The host's game loop is driven by a Web Worker timer, so it keeps running when the host's tab is
  in the background.
* Each **client moves its own survivor** locally, so movement is instant. The host checks every
  move (speed budget + wall collision) and corrects the client if needed.
* Other players and enemies are **interpolated** about 110 ms behind for smooth motion.
* Blood and scorch marks are painted onto the floor texture, so the arena gets messier as the
  fight goes on.

### Development

Edit the files in `public/`, then serve that folder (ES modules don't load from `file://`):

```sh
python3 -m http.server 8000 -d public     # open http://localhost:8000
python3 build.py                          # rebuild cube-siege.html when done
```

In the browser console, `window.__cs.game` exposes the running client game.
