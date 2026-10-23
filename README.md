# Project Page: Hybrid Multi-Goal Path Planning for Powered Wheelchairs

Source of the static project page, served with GitHub Pages.

**Live site:** <https://egeozgul.github.io/AutonomousWheelchairProject/>

## What the page shows

- Paper title, authors, abstract, and setup figures
- A synchronized player for each hardware experiment: overhead video, the wheelchair's two forward cameras, and an animated path plot
- A 3D LiDAR point cloud player for experiments that have a LiDAR recording

## Repository layout

```
├── index.html              The page
├── pointcloud_player.js    3D LiDAR player, reads the bags in the browser
├── config.json             Experiments listed on the page: names, files, offsets, environments
├── <experiment>/           One folder per experiment
└── *.jpg, *.png            Figures and logos
```

An experiment folder can contain:

| File | Used for |
| --- | --- |
| `overhead_web.mp4` | Overhead view |
| `cam1_detected.mp4`, `cam2_detected.mp4` | Forward camera views |
| `*.csv` | Path plot: `t`, `chair_x`, `chair_y`, `chair_yaw`, plus `<name>_x`, `<name>_y` per pedestrian |
| `lidar_bag/lidar_bag_0_filtered.db3` | Point cloud player (ROS 2 SQLite bag with `/livox/lidar` and `/vehicle/odometry`) |

## Adding an experiment

1. Create a folder and upload its files.
2. Add an entry to `projects` in `config.json` with its `id`, `name`, `folder`, and `files`.
3. Commit. GitHub Pages republishes the site within a minute or two.

The point cloud player lists an experiment automatically once its `lidar_bag/lidar_bag_0_filtered.db3` exists.
To use a different bag name, set `"lidarBag"` in that experiment's `files`.

**File size:** keep files under 25 MB when uploading through the GitHub website, and don't store bags with
Git LFS, since GitHub Pages serves only a pointer for LFS files.

## Previewing locally

The page loads its data with `fetch`, which browsers block for files opened directly from disk.
Serve the folder instead:

```bash
python -m http.server 8000
```

Then open <http://localhost:8000>.
