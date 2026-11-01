# idrive7-apps

Apps for BMW iDrive 7 head units, installed through robertn_store.

- **G's Dash** (`ng_gsdash`): driver display and car hub in six looks, with a home-screen widget. Cluster skins that match your look, a full HUD (speed, gear, shift lights), and a Cluster source picker.
  Optional *Cluster map* setting: requires the Waze on cluster tool from the Store; off by default;
  untested on most firmware. To revert, set it Off and restart the head unit, or remove the tool.
- **G's Music** (`ng_spotify`): full-screen Spotify player with lyrics, a visualizer and a home-screen
  widget. Needs Spotify Premium and internet through the Store's uplink. Setup: [docs/spotify.md](docs/spotify.md). 0.6.0 shows synced lyrics or a visualizer in the cluster while music plays.
- **G's TV** (`ng_tv`): experimental. TV channels with a guide, channel up/down and fullscreen, plus your own
  direct MP4 links added from your phone. Picture only while parked, video only. Needs internet
  through the Store's uplink. 0.4.3 adds instant resume after driving, a HUD button, and parked-only video in the cluster's centre map area.

## Install

1. On the car, open **robertn_store → Settings → Add source**.
2. Enter `nickgcode/idrive7-apps` (or paste this repository's link) and save.
3. The apps appear in the Store's list. Choose one and tap **Install**. Updates appear there as well.

The Store builds each app on the head unit from this repository (`mgu-repo.json`, `kit/`); nothing
here contains BMW's SDK. To remove an app, uninstall it in the Store.

## Disclaimer

Unofficial. Not made, endorsed or supported by BMW or by the Store's author. Use at your own risk:
you are responsible for your car and for how you use these apps. Don't let them distract you while driving.

## License

MIT, see [LICENSE](LICENSE). Bundled third-party code keeps its own licence:
[kit/LICENSE.idrive7-apps](kit/LICENSE.idrive7-apps), [apps/ng_spotify/LICENSE](apps/ng_spotify/LICENSE),
[apps/ng_tv/LICENSE](apps/ng_tv/LICENSE).
