# Cube Siege

A top-down **co-op survival shooter** for the browser. 1–8 blocky survivors hold out
against waves of undead, chain kills for score multipliers, unlock a growing
arsenal and build defenses. Play endless **Classic**, the perk-driven **Gauntlet**, or
**Missions**: a 10-level defense campaign plus **Breakthrough**, where you fight your way across a
long map zone by zone, complete objectives and escort a scientist.

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
4. In the lobby everyone picks a **character** (Survivor, Soldier, Cowboy, Robot, Ninja, Punk,
   Chef, Viking). Characters only change your look. The host picks the **mode**, the **map**
   (or mission), the **difficulty**, **friendly fire** and which **undead types** can appear.
5. The host clicks **Start game**. Players can also drop into a running game and spawn at the
   next wave break.

Notes:
* An internet connection is needed (for the PeerJS library, the broker and the fonts).
* The host's browser runs the game. **The host must keep the tab open** until the round is
  over. It keeps running in the background if the host switches windows.
* Peer-to-peer works on almost all home networks. Very strict firewalls (some corporate or
  university networks) can block it, and the join will then time out with a message.

## Controls

Play with the **keyboard only**, or keyboard + mouse. The game switches automatically:
pressing Space or Shift selects keyboard aiming, and moving or clicking the mouse selects mouse aiming.

| Action | Keyboard only | With mouse |
|---|---|---|
| Move | `W A S D` or arrow keys | `W A S D` or arrow keys |
| Aim | you face the way you last moved; aim-assist locks onto an enemy close to that direction (red brackets) | mouse |
| Shoot / place | hold `Space`: your aim **locks**, so moving strafes without turning you. The dashed line shows where shots go. Aim-assist keeps tracking the enemy it has locked on to | hold left button |
| Lock aim without shooting | hold `Shift` | not needed |
| Use: hack, drop fuel, take a structure apart | hold `F` | hold `F` or right button |
| Select weapon | `1`–`9`, `0` | `1`–`9`, `0` |
| Previous / next weapon | `Q` / `E` | `Q` / `E` or mouse wheel |
| Chat | `Enter` | `Enter` |
| Pick a perk (Gauntlet / Missions) | `Z` `X` `C` | `Z` `X` `C` or click the card |
| Scoreboard | hold `Tab` | hold `Tab` |
| Menu: resume, restart or end the round, sound, leave | `Esc` (the host's menu pauses the game for everyone) | `Esc` |
| Mute sound | `M` | `M` |

## Difficulty

| | Enemy HP | Enemy speed | Enemy damage | Wave size | Drops |
|---|---|---|---|---|---|
| Easy | 70% | 85% | 60% | 75% | more |
| Normal | 100% | 100% | 100% | 100% | normal |
| Hard | 135% | 110% | 135% | 125% | fewer |
| Nightmare | 180% | 122% | 175% | 150% | fewer |

## Friendly fire

The host picks this in the lobby. It applies to every mode.

| Setting | Effect |
|---|---|
| **Off** | Bullets pass through teammates and your own explosives are safe |
| **Light** | Teammates stop your bullets and take 25% damage. Flames and explosions hurt them too, and your own explosives hurt you |
| **Full** | The same at 100% damage. A careless rocket can wipe the team |

Sentries and bloaters don't change: sentries never hit friends, and bloaters hurt everyone in every setting.
Dr. Block can be hit too. The results screen adds a **Team damage** column when friendly fire is on.

## Game modes

| Mode | What it is |
|---|---|
| **Classic** | Endless waves. Unlock the arsenal and hold out as long as you can. Elite undead start showing up after wave 15. |
| **Gauntlet** | Endless waves, but after every wave each player **picks a perk**, every wave from 3 on gets a random **mutator** (two from wave 12), and **elite** undead appear from wave 4. |
| **Missions** | Two campaigns, **Siege** (10 defense levels on the five maps) and **Breakthrough** (5 levels across long maps), each with objectives and a fixed undead roster. Clearing a mission unlocks the next one in its campaign (progress is saved in your browser). Perks after every wave or zone. |

Your best wave per mode and difficulty is remembered and shown in the lobby.

### Perks

Picked from three random offers after each wave. If you don't pick, the offer stays (and stacks up) until you do.

| Perk | Effect | Max |
|---|---|---|
| Toughness | +25 max health | 3 |
| Quick Feet | +10% move speed | 3 |
| Big Guns | +15% weapon damage | 5 |
| Trigger Finger | +12% fire rate and max ammo | 3 |
| Deep Pockets | +50% max ammo and ammo pickups | 2 |
| Vampire | Heal 1 HP per kill | 3 |
| Field Medic | Revive teammates 2x faster, bleed out 10s slower | 1 |
| Combo Artist | +1s to chain the next kill | 2 |
| Demolitions | +25% explosion size and damage | 2 |
| Regeneration | Regain 2 HP/s after 3s without damage | 2 |
| Scavenger | +35% drop chance | 2 |
| Second Wind | Once per wave, get back up on your own after 3s | 1 |

### Mutators (Gauntlet)

Blood Moon (faster undead), Ironhide (+50% health), Swarm (60% more but weaker), Blackout (darkness),
Volatile (undead may explode on death), Gold Rush (double points), Champions (many elites),
Undying (undead regenerate), Glass Cannons (less health, harder hits).

**Elite** undead have a pulsing gold ring: 3x health, a bit bigger, faster and stronger, worth 3x points and
they always drop something (sometimes an upgrade crate).

### Siege missions

| # | Mission | Map | Objective |
|---|---|---|---|
| 1 | First Night | Rust Depot | Survive 5 waves |
| 2 | Power Down | Bunker 9 | Keep the generator alive for 6 waves (the undead go for it) |
| 3 | Scavenger Run | Crossroads | Find 6 fuel cans (arrows at the screen edge point to them) |
| 4 | The Pack | Dusk Orchard | Survive 7 waves of fast hunters |
| 5 | Juggernaut | Rust Depot | Survive 6 waves, the Juggernaut arrives on the last |
| 6 | Acid Rain | Old Cemetery | Hold out for 4 minutes |
| 7 | Lights Out | Bunker 9 | Survive 8 waves in the dark, with wraiths |
| 8 | Harvest Moon | Dusk Orchard | Defend the generator for 8 waves under a blood moon |
| 9 | Unholy Choir | Old Cemetery | Find 8 fuel cans while shamans heal the horde |
| 10 | Last Stand | Crossroads | 10 waves of everything, both bosses at the end |

Later missions start with more weapons unlocked and tougher undead.

### Breakthrough missions

You start at the left end of a long map. Blast doors divide it into zones, and whatever lies beyond
the next door stays hidden. Each zone has tasks to finish in order. Then the door opens, everyone who
fell comes back, and each player gets a perk and supplies. The next zone stays quiet until someone
walks through (or 45 seconds pass), so the team sets the pace.

| # | Mission | Map | Zones | Tasks |
|---|---|---|---|---|
| 1 | Breach | Depot Backlot | 3 | Clear, nests, hack, extract |
| 2 | Dr. Block | Bunker Depths | 4 | Escort: clear, hack, nests, hold, with a door to fix in each zone, then extract |
| 3 | Fuel Line | Main Street | 4 | Fuel, two hacks, breach charge, Juggernaut, extract |
| 4 | Consecrate | The Long Graveyard | 4 | Nests, two holds, clear, Colossus, extract |
| 5 | The Long Way Home | Orchard Road | 5 | Escort: every task type, then both bosses and extract |

| Task | What you do |
|---|---|
| **Clear** | Kill a fixed horde |
| **Nests** | Destroy pulsing sacs that keep hatching undead |
| **Hack** | Hold `F` at a terminal. You can't shoot while you work, so someone has to guard you. Progress slowly fades if you leave. Helpers speed it up, and playing solo it runs faster with fewer undead |
| **Fuel** | Carry cans to the generator, one at a time. You are slower and limited to the pistol. Going down drops the can |
| **Hold** | Keep at least one survivor inside the circle until it fills |
| **Charge** | Guard the breach charge until it blows. If it is destroyed, the mission fails |
| **Fix** | Keep undead off Dr. Block. They walk to the door and work on it, and stop whenever an undead gets close |
| **Boss** | The door stays shut until the boss dies |
| **Extract** | Every survivor still standing (and Dr. Block) has to stay in the circle for 10 seconds |

**Dr. Block** is the scientist you escort. They follow the nearest survivor, squeeze past barricades and
draw undead like any player. Stand next to them to revive them when they go down. If they bleed
out, the mission fails.

## How a round works

* **Waves**: each wave sends more enemies, and later waves add tougher types. Every 5th wave
  brings a boss (the **Colossus** and the **Juggernaut** take turns). There is a 9 second break between waves.
* **Combo multiplier**: each kill within 2.6 s of your previous kill extends your chain. Every
  4 chained kills raise your multiplier (up to **x10**), and kill points are multiplied by it.
* **Unlocks**: all kill points go into the **team score**. Reaching a threshold unlocks the next
  weapon for everyone, with half a load of ammo. The bar above the weapon slots shows progress.
* **Pickups**: enemies sometimes drop **ammo crates** (refill every unlocked weapon a bit) and
  **med-kits** (+35 HP). Two extra crates appear at every wave break.
* **Weapon upgrades**: a slain Colossus drops one golden **upgrade crate** per player (brutes
  drop one now and then). Each crate shows its upgrade's name. Walk over it to keep that upgrade
  for the rest of the round; it also refills that weapon. Upgrades are personal, so leave the
  ones you already own for your teammates. If the Colossus is switched off, the crates appear
  after every 5th wave instead.
* **Downed & revive**: at 0 HP you go down and bleed out after 25 s. A teammate who stands next
  to you for 2.5 s revives you (several helpers revive faster). If you bleed out, you respawn
  when the wave is cleared.
* **Game over**: when no survivor is left standing. Playing solo, going down ends the game
  (unless Second Wind gets you up).
* **Menu**: `Esc` opens it for everyone. For the host it also freezes the game and offers **Restart round** and
  **End round** (which shows the results as usual, and isn't counted as a defeat). Other players can leave from
  theirs while the game keeps running.
* **Boxed in**: you can wall yourself in, and that is a fair tactic, but not a permanent one. Hold `F` next to a
  barricade, sentry or mine to take it apart (anyone can, in 0.6 s). You get the charge back only if it was
  practically new. While a survivor has no walkable route to the undead gates, a warning shows, and after 10 s
  the undead start breaking structures faster, up to 3x at 30 s. Structures can't be built on top of objectives.

## Arsenal

| # | Weapon | Unlocks at | Notes |
|---|---|---|---|
| 1 | Pistol | start | Infinite ammo, accurate |
| 2 | SMG | 400 | Very fast, some spread |
| 3 | Shotgun | 1,300 | 8 pellets, close range |
| 4 | Barricade | 2,600 | Places a wooden block (450 HP). Blocks enemies and players, not bullets |
| 5 | Assault Rifle | 4,500 | Fast, accurate, long range |
| 6 | Mines | 7,000 | Dropped at your feet, big blast when an enemy steps on them |
| 7 | Flamethrower | 10,500 | Short cone, sets enemies on fire |
| 8 | Railgun | 15,000 | Pierces every enemy in a line |
| 9 | Rocket Launcher | 21,000 | Large explosion |
| 0 | Sentry Gun | 28,000 | Auto-turret, lasts 60 s or 260 shots |

Unless the host turns on [friendly fire](#friendly-fire), you can't hurt teammates or yourself, so fire freely.

The numbers are tuned against the [balance metric](#balance-metric).

### Upgrades

| Weapon | Upgrade | Effect |
|---|---|---|
| Pistol | Hair Trigger | Fires 35% faster |
| Pistol | Dual Pistols | Two bullets per shot, each weaker |
| SMG | Drum Mag | Double ammo, 25% faster fire |
| SMG | Hot Rounds | Bullets burn enemies and hit 20% harder |
| Shotgun | Auto Shotgun | Fires 60% faster |
| Shotgun | Long Barrel | +50% range, tight 10-pellet spread |
| Shotgun | Dragon's Breath | Incendiary shells |
| Barricade | Steel Plating | 3x health |
| Assault Rifle | AP Rounds | Bullets pierce enemies, 35% less damage |
| Assault Rifle | Marksman | +40% damage, tighter spread |
| Mines | Big Boom | Bigger radius, more damage |
| Railgun | Capacitor | Fires 60% faster |
| Flamethrower | Napalm | +30% range, wider cone |
| Rocket Launcher | Cluster Rockets | Each rocket scatters 6 bomblets |
| Rocket Launcher | Rapid Launcher | Fires 60% faster |
| Sentry Gun | Heavy Sentry | Lasts 2x longer, hits harder |

Upgrades on the same weapon stack by multiplying. Owned upgrades show as gold pips on the weapon bar.

## Balance metric

Open **`cube-siege-balance.html`** (double-click works) to see how fair the arsenal is. Everything comes from the
game's own code, so after changing numbers in `public/js/sim.js` just run `python3 build.py` and reload.

The **Weapon Power Index (WPI)** fires each gun at fixed targets using the game's real stats and spread rules. A stock
pistol is 100.

```
WPI = single-target DPS^0.3 x crowd DPS^0.3 x sustained DPS^0.4
```

*Sustained* DPS covers a 60-second fight with one ammo crate every 20 seconds, falling back to the pistol once the gun
runs dry. That is what makes infinite ammo count.

The **Balance Score** (out of 100) checks seven situations, from stock weapons to full upgrades with all perks:

| Part | Weight | What it checks |
|---|---|---|
| Power curve and ladder | 70% | Power grows smoothly with unlock order (40), later guns beat earlier ones (30), and the free pistol stays below every gun you earn (30) |
| Perk fairness | 10% | A perk helps all weapons about equally |
| Upgrade lottery | 10% | Upgrades are random drops, so a fully upgraded pistol shouldn't beat stock guns |
| Upgrade size | 10% | Each upgrade is worth x1.04 to x1.75 on its own weapon (the target is x1.25 to x1.75) |

The **field test** on the same page checks the model against reality: a bot plays real rounds of Classic with one
weapon, and you see the wave it reaches. The same test values each perk. Bots aim better than they dodge, and results are noisy, so
read it for big gaps rather than small differences.

## Enemies

| Enemy | First wave | Behaviour |
|---|---|---|
| **Shambler** | 1 | Slow, green and numerous. The backbone of every horde |
| **Sprinter** | 2 | Pale and fragile, but twice as fast |
| **Warlock** | 3 | Horned caster. Keeps its distance and lobs fireballs that also wreck barricades |
| **Brute** | 4 | Huge and slow, with lots of health. Hard to knock back |
| **Bloater** | 6 | Explodes when it reaches you or dies. The blast also hurts other undead |
| **Leaper** | 5 | Crouches (blinking red "!") then pounces across the room |
| **Spitter** | 7 | Keeps its distance and lobs acid that leaves burning pools on the floor |
| **Riot** | 8 | Carries a shield that blocks bullets from the front until it breaks. Flank it or use explosives, fire, the railgun or AP rounds |
| **Shaman** | 9 | Hangs back and heals every undead around it. Kill it first |
| **Splitter** | 10 | Bursts into three fast little Splitlings when it dies |
| **Wraith** | 12 | Ghost that drifts straight through walls and barricades |
| **Colossus** | 5, 15, 25… | Boss. Fires rings of fireballs and summons minions. Health scales with player count |
| **Juggernaut** | 10, 20… | Boss. Roars, then charges in a straight line, smashing barricades and knocking you aside. Slamming into a wall stuns it, and it takes 50% more damage while stunned |

From wave 10 on, two bosses come at once.
Enemy health grows about 11% per wave and speed about 1.2% per wave (up to +20%). Enemy count scales with the number of players.
Enemies path around walls with a flow field and smash through barricades when those block the shortest route.

## Maps

* **Rust Depot**: open warehouse yard, crate stacks and L-shaped cover, four gates.
* **Crossroads**: town streets around a central square, with long sight lines.
* **Bunker 9**: nine concrete rooms joined by narrow doors. Chokepoint heaven.
* **Dusk Orchard**: fenced orchard at sunset, full of trees, with gates on every side.
* **Old Cemetery**: foggy graveyard with rows of tombstones around a ruined chapel.

Breakthrough missions have their own maps, built by `makeRun` from a list of zones and an obstacle style.

Maps are generated by small functions in `public/js/sim.js`. Add a `make*` function and
an entry in `MAPS`/`THEMES` to create your own. Tile legend: `#` wall, `B` crate,
`T` tree/pillar, `.`/`,` floor, `S` enemy spawn, `P` player spawn, `D` blast door.

## How it works

```
cube-siege.html     the whole game in one file (generated by build.py)
cube-siege-balance.html  the balance lab in one file (generated by build.py)
build.py            bundles public/ into those two files
public/index.html   menu, lobby and results screens
public/js/main.js   UI flow, PeerJS hosting/joining, frame loop
public/js/host.js   the room "server" running in the host's browser (lobby, 30 Hz game loop)
public/js/sim.js    authoritative simulation: maps, enemies, AI, weapons, waves, score
public/js/game.js   client game: interpolation, movement prediction, input, effects, HUD
public/js/render.js canvas renderer: pseudo-3D blocks, characters, lighting
public/js/audio.js  procedural WebAudio sound effects
public/balance.html, public/js/lab.js   the balance lab page
public/js/balance.js   the balance metric and field test
public/js/bot.js    a simple player bot for the field test and the tests
tests/              tests for the simulation, the host and the balance metric
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

### Deploying to GitHub Pages

`.github/workflows/deploy.yml` publishes `public/` on every
push to `main` that changes it. No build step is needed: Pages serves the ES modules as they are.

1. Push this repository to GitHub.
2. In the repository, open **Settings → Pages** and set **Source** to **GitHub Actions**.
3. Push a change to `public/`, or start the workflow by hand from the **Actions** tab.

The game then runs at `https://<user>.github.io/<repo>/`, and invite links work from there.

### Development

Edit the files in `public/`, then serve that folder (ES modules don't load from `file://`):

```sh
python3 -m http.server 8000 -d public     # open http://localhost:8000
python3 build.py                          # rebuild the bundled files when done
```

To run the tests, serve the project folder and open `/tests/`, or use Node if you have it:

```sh
python3 -m http.server 8000               # open http://localhost:8000/tests/
node tests/sim.test.mjs
```

In the browser console, `window.__cs.game` exposes the running client game and `window.__cs.host` the room
(on the host's browser; `window.__cs.host.game` is the authoritative simulation).
