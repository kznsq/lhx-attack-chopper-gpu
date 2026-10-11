"""Builds the Enhanced-mode terrain of each LHX theatre from real satellite imagery and elevation.

    python3 -I tools/terrain.py <battlefields dir> <out dir>

<battlefields dir> holds one JSON file per theatre (gulf, asia, europe) with the game's place
names and object positions, made by a separate extractor for the game's theatre files (not part of
this repository); models.json beside that directory gives the hill models' sizes. Downloaded tiles are kept in <out dir>/tiles and reused.

Georeference: the game's maps are schematic (real distances are 1.5 to 2 times the game's), so each
theatre is placed by a similarity transform (scale, rotation, shift) fitted to the game's town
positions and their real coordinates. The real land is squeezed by that scale, heights included,
so shapes and slopes keep their proportions.

Sources:
  imagery    Sentinel-2 cloudless 2016 by EOX IT Services GmbH (contains modified Copernicus
             Sentinel data 2016), CC BY 4.0, https://s2maps.eu
  elevation  Terrain Tiles on AWS Open Data (Mapzen terrarium encoding; SRTM, GMTED and others)
  anchors    OpenStreetMap Nominatim (ODbL)

Output per theatre (game coordinates: half-feet, x east, z north; rows run north to south):
  <name>.json          bounds of the two grids, the fit, attribution
  <name>_near.jpg      colour, play area and margin
  <name>_far.jpg       colour, wide surroundings
  <name>_near.i16      heights in game half-feet, little-endian int16, row-major
  <name>_far.i16
"""
import io, json, math, os, sys, time, urllib.request
import numpy as np
from PIL import Image

HALF_FT = 0.1524                 # metres per game unit
EARTH = 6378137.0
UA = {'User-Agent': 'lhx-js-terrain/1.0 (personal research)'}
IMAGERY = 'https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless_3857/default/g/{z}/{y}/{x}.jpg'
ELEVATION = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'

# Game place name -> real (latitude, longitude). Wahrenholz (Europe) is left out: the game puts it
# about 30 km from where it is. Air bases are matched to the town they are named after.
ANCHORS = {
    'europe': {
        'Beetzendorf': (52.7033, 11.0918), 'Brome': (52.6002, 10.9366), 'Trippigleben': (52.5390, 11.1522),
        'Ruhen': (52.4859, 10.8854), 'Buchhorst': (52.4869, 11.0236), 'Rohrberg': (52.7122, 11.0189),
        'Jubar': (52.6686, 10.9272), 'Diesdorf': (52.7513, 10.8757), 'Dahre': (52.7996, 10.9075),
        'Kusey': (52.5824, 11.0966), 'Boitzenhagen AFB': (52.6214, 10.8138),
        'Wolfsburg AFB': (52.4206, 10.7862), 'Schmolau AFB': (52.8119, 10.7793),
    },
    'asia': {'Dong Ha': (16.8025, 107.0953), 'Gio Linh': (16.9235, 107.0853), 'Cam Lo Air Base': (16.8075, 106.9935)},
    'gulf': {'Jadu': (31.9528, 12.0273), 'Shakshuk': (32.0200, 11.9494), 'Al Jawsh AFB': (31.9947, 11.6732)},
}

NEAR_MARGIN = 4000 / HALF_FT     # beyond the play area, game units
NEAR_PIXELS, NEAR_HEIGHTS = 6144, 1024
FAR_SIDE = 160000 / HALF_FT      # wide grid side, game units
FAR_PIXELS, FAR_HEIGHTS = 2048, 512


class Fit:
    """real local metres (east, north) = a * (game metres) + b, as complex numbers"""

    def __init__(self, theatre, places):
        anchors = ANCHORS[theatre]
        names = [n for n in anchors if n in places]
        self.lat0 = float(np.mean([anchors[n][0] for n in names]))
        self.lon0 = float(np.mean([anchors[n][1] for n in names]))
        g = np.array([complex(*places[n]) for n in names])
        r = np.array([complex(*self.local(*anchors[n])) for n in names])
        gc, rc = g.mean(), r.mean()
        self.a = np.vdot(g - gc, r - rc) / np.vdot(g - gc, g - gc)
        self.b = rc - self.a * gc
        res = r - (self.a * g + self.b)
        self.residuals = {n: round(float(abs(e))) for n, e in zip(names, res)}

    def local(self, lat, lon):
        return ((lon - self.lon0) * math.pi / 180 * EARTH * math.cos(math.radians(self.lat0)),
                (lat - self.lat0) * math.pi / 180 * EARTH)

    def latlon(self, gx, gz):
        """game units (arrays) -> latitude, longitude"""
        q = self.a * (gx * HALF_FT + 1j * gz * HALF_FT) + self.b
        return (self.lat0 + np.degrees(q.imag / EARTH),
                self.lon0 + np.degrees(q.real / (EARTH * math.cos(math.radians(self.lat0)))))

    @property
    def scale(self):
        return abs(self.a)


def mercator(lat, lon, z):
    """latitude, longitude -> global pixel coordinates of 256-pixel tiles at zoom z"""
    n = 256 * 2 ** z
    return (lon + 180) / 360 * n, (1 - np.arcsinh(np.tan(np.radians(lat))) / math.pi) / 2 * n


def zoom_for(metres_per_pixel, lat, finer=False):
    """tile zoom whose resolution is nearest to metres_per_pixel (finer: at least that fine)"""
    z = math.log2(2 * math.pi * EARTH * math.cos(math.radians(lat)) / 256 / metres_per_pixel)
    return max(1, math.ceil(z) if finer else round(z))


def fetch(url, path):
    if os.path.exists(path):
        return open(path, 'rb').read()
    for attempt in range(4):
        try:
            data = urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=30).read()
            break
        except Exception as e:
            if attempt == 3:
                raise
            time.sleep(2 + attempt * 3)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    open(path, 'wb').write(data)
    time.sleep(0.05)
    return data


def mosaic(url, cache, z, px, py, decode):
    """tiles covering the pixel coordinates px, py -> (array, x origin, y origin)"""
    tx0, tx1 = int(px.min() // 256), int(px.max() // 256) + 1
    ty0, ty1 = int(py.min() // 256), int(py.max() // 256) + 1
    out = None
    total = (tx1 - tx0 + 1) * (ty1 - ty0 + 1)
    done = 0
    for ty in range(ty0, ty1 + 1):
        for tx in range(tx0, tx1 + 1):
            ext = url.rsplit('.', 1)[1]
            raw = fetch(url.format(z=z, x=tx, y=ty), f'{cache}/{z}/{tx}_{ty}.{ext}')
            tile = decode(raw)
            if out is None:
                out = np.zeros(((ty1 - ty0 + 1) * 256, (tx1 - tx0 + 1) * 256) + tile.shape[2:], tile.dtype)
            out[(ty - ty0) * 256:(ty - ty0 + 1) * 256, (tx - tx0) * 256:(tx - tx0 + 1) * 256] = tile
            done += 1
        print(f'    {cache.rsplit("/", 1)[1]} z{z}: {done}/{total} tiles', end='\r', flush=True)
    print()
    return out, tx0 * 256, ty0 * 256


def bilinear(img, x, y):
    x = np.clip(x, 0, img.shape[1] - 1.001); y = np.clip(y, 0, img.shape[0] - 1.001)
    x0 = x.astype(int); y0 = y.astype(int); fx = x - x0; fy = y - y0
    if img.ndim == 3:
        fx = fx[..., None]; fy = fy[..., None]
    a = img[y0, x0] * (1 - fx) + img[y0, x0 + 1] * fx
    b = img[y0 + 1, x0] * (1 - fx) + img[y0 + 1, x0 + 1] * fx
    return a * (1 - fy) + b * fy


def jpeg(raw):
    return np.asarray(Image.open(io.BytesIO(raw)).convert('RGB'), np.float32)


def terrarium(raw):
    t = np.asarray(Image.open(io.BytesIO(raw)).convert('RGB'), np.float32)
    return t[..., 0] * 256 + t[..., 1] + t[..., 2] / 256 - 32768


SAND = np.array([196, 172, 136], np.float32)   # natural colour of the median desert ground


def grading(img):
    """Sentinel-2 cloudless 2016 is overexposed over bright desert: red and green sit at 255 while
    blue keeps the detail. Returns how to rebuild red and green from blue (the median red/blue and
    green/blue of the unclipped land) and the median of the rebuilt colours, or None when the
    imagery is not clipped."""
    r, g, b = img[..., 0], img[..., 1], img[..., 2]
    clip = (r >= 250) | (g >= 250)
    if clip.mean() < 0.2:
        return None
    land = ~clip & (r > b) & (b > 20)     # sea is bluer than it is red
    kr, kg = float(np.median(r[land] / b[land])), float(np.median(g[land] / b[land]))
    rebuilt = rebuild(img, kr, kg)
    return kr, kg, np.median(rebuilt[land | clip], 0)


def rebuild(img, kr, kg):
    r, g, b = img[..., 0], img[..., 1], img[..., 2]
    return np.stack([np.where(r >= 250, np.maximum(r, b * kr), r), np.where(g >= 250, np.maximum(g, b * kg), g), b], -1)


def regrade(img, params):
    """clipped imagery: rebuilt, then balanced so the median ground is SAND, contrast kept"""
    if params is None:
        return img
    kr, kg, median = params
    return (np.maximum(rebuild(img, kr, kg), 0) / median) ** 1.25 * SAND


# Real airfields are graded flat: the ground under each runway (model box, game units) and a
# margin around it is levelled, blending back into the land around it.
RUNWAY_BOX = (-256, 256, -3328, 3072)
LEVEL_MARGIN, LEVEL_BLEND = 800, 2500


def level_runways(h, gx, gz, runways):
    for rx, rz, heading in runways:
        a = math.radians(heading)
        dx, dz = gx - rx, gz - rz
        along = -math.sin(a) * dx + math.cos(a) * dz
        across = math.cos(a) * dx + math.sin(a) * dz
        x0, x1, z0, z1 = RUNWAY_BOX
        ex = np.maximum(np.maximum(x0 - LEVEL_MARGIN - across, across - x1 - LEVEL_MARGIN), 0)
        ez = np.maximum(np.maximum(z0 - LEVEL_MARGIN - along, along - z1 - LEVEL_MARGIN), 0)
        dist = np.hypot(ex, ez)
        inside = dist == 0
        if not inside.any():
            continue
        level = np.median(h[inside])
        t = np.clip(dist / LEVEL_BLEND, 0, 1)
        w = 1 - t * t * (3 - 2 * t)
        h[:] = h * (1 - w) + level * w
    return h


# Seen from the air, ground in Sentinel-2 cloudless reads darker than it looks to a pilot (dense
# vegetation is a quarter grey or less). Darker imagery gets a gamma curve that brings its median
# brightness here: shadows and middle tones lift, highlights stay.
GROUND_MEDIAN = 0.36


def exposure(img):
    lum = np.median(img @ np.array([0.3, 0.59, 0.11], np.float32)) / 255
    return math.log(GROUND_MEDIAN) / math.log(lum) if lum < GROUND_MEDIAN else None


def expose(img, gamma):
    return img if gamma is None else 255 * np.clip(img / 255, 0, 1) ** gamma


HILL_MODELS = ('hill1', 'hill2', 'hill3', 'hill4', 'mountain')


def hills(info, models_json):
    """the game's hill and mountain objects: centre, heading, footprint and height, game units"""
    size = {m['name']: m['lods'][-1]['size_m'] for m in json.load(open(models_json)) if m['name'] in HILL_MODELS}
    return [{'x': o['world'][0], 'z': o['world'][2], 'heading_deg': o['heading_deg'],
             'w': round(size[o['model']][0] / HALF_FT), 'h': round(size[o['model']][1] / HALF_FT),
             'l': round(size[o['model']][2] / HALF_FT)}
            for o in info['objects'] if o['model'] in size]


def grid(fit, bounds, size):
    """game coordinates of a size x size grid over bounds, row 0 at the north edge"""
    x0, x1, z0, z1 = bounds
    gx = x0 + (np.arange(size) + 0.5) / size * (x1 - x0)
    gz = z1 - (np.arange(size) + 0.5) / size * (z1 - z0)
    return np.meshgrid(gx, gz)


def raster(fit, bounds, size, url, cache, metres, decode, finer=False):
    gx, gz = grid(fit, bounds, size)
    lat, lon = fit.latlon(gx, gz)
    z = zoom_for(metres, fit.lat0, finer)
    px, py = mercator(lat, lon, z)
    img, ox, oy = mosaic(url, cache, z, px, py, decode)
    out = np.empty((size, size) + img.shape[2:], np.float32)
    for r in range(0, size, 512):
        out[r:r + 512] = bilinear(img, px[r:r + 512] - ox, py[r:r + 512] - oy)
    return out, z


def build(theatre, info, out, models_json):
    places = {p['name']: (-p['position_m'][0], p['position_m'][1]) for p in info['places']}
    fit = Fit(theatre, places)
    s = fit.scale
    print(f'{theatre}: scale {s:.2f} (real/game), rotation {math.degrees(np.angle(fit.a)):.1f} deg, '
          f'residuals {fit.residuals} m')
    # play area: every placed object, in game units
    xs = [o['world'][0] for o in info['objects']]
    zs = [o['world'][2] for o in info['objects']]
    cx, cz = (min(xs) + max(xs)) / 2, (min(zs) + max(zs)) / 2
    half = max(max(xs) - min(xs), max(zs) - min(zs)) / 2 + NEAR_MARGIN
    near = [cx - half, cx + half, cz - half, cz + half]
    far = [cx - FAR_SIDE / 2, cx + FAR_SIDE / 2, cz - FAR_SIDE / 2, cz + FAR_SIDE / 2]
    tiles = f'{out}/tiles'
    runways = [(o['world'][0], o['world'][2], o['heading_deg']) for o in info['objects'] if o['model'] == 'runway']
    result = {'theatre': info['theatre'], 'ground_colour': info['ground_colour'], 'fit': {
        'scale': s, 'rotation_deg': math.degrees(np.angle(fit.a)), 'lat0': fit.lat0, 'lon0': fit.lon0,
        'a': [fit.a.real, fit.a.imag], 'b': [fit.b.real, fit.b.imag], 'residuals_m': fit.residuals},
        'units': 'game half-feet; x east, z north; rows run north to south; heights int16 half-feet',
        'attribution': ['Sentinel-2 cloudless 2016 by EOX IT Services GmbH (contains modified Copernicus Sentinel data 2016), CC BY 4.0',
                        'Terrain Tiles, AWS Open Data (Mapzen terrarium): SRTM, GMTED and others',
                        'Place coordinates: OpenStreetMap contributors (ODbL)']}
    grade = None
    for label, bounds, pixels, heights in (('near', near, NEAR_PIXELS, NEAR_HEIGHTS), ('far', far, FAR_PIXELS, FAR_HEIGHTS)):
        game_m = (bounds[1] - bounds[0]) * HALF_FT
        colour, zc = raster(fit, bounds, pixels, IMAGERY, f'{tiles}/s2cloudless', game_m / pixels * s, jpeg)
        if label == 'near':
            grade = grading(colour)       # the same corrections for both grids, so they meet without a seam
            if grade:
                result['colour_rebuilt'] = {'red_per_blue': grade[0], 'green_per_blue': grade[1]}
            gamma = exposure(regrade(colour, grade))
            if gamma:
                result['gamma'] = gamma
        colour = expose(regrade(colour, grade), gamma)
        Image.fromarray(np.clip(colour, 0, 255).astype(np.uint8)).save(f'{out}/{theatre}_{label}.jpg', quality=88)
        h, ze = raster(fit, bounds, heights, ELEVATION, f'{tiles}/terrarium', game_m / heights * s, terrarium, finer=True)
        # sea surface for the sea floor; squeeze heights like the ground
        h = np.maximum(h, 0) / s / HALF_FT
        gx, gz = grid(fit, bounds, heights)
        h = level_runways(h, gx, gz, runways)
        h.round().astype('<i2').tofile(f'{out}/{theatre}_{label}.i16')
        result[label] = {'bounds': [round(v, 1) for v in bounds], 'pixels': pixels, 'heights': heights,
                         'imagery_zoom': zc, 'elevation_zoom': ze,
                         'height_range': [int(h.min()), int(h.max())]}
        print(f'  {label}: {game_m / 1000:.0f} km (game) at {game_m / pixels:.1f} m per pixel, imagery z{zc}, '
              f'elevation z{ze}, heights {h.min() * HALF_FT * s:.0f}..{h.max() * HALF_FT * s:.0f} m real')
    result['hills'] = hills(info, models_json)
    json.dump(result, open(f'{out}/{theatre}.json', 'w'), indent=1)


def main():
    src, out = sys.argv[1], sys.argv[2]
    os.makedirs(out, exist_ok=True)
    for theatre in sys.argv[3:] or ANCHORS:
        build(theatre, json.load(open(f'{src}/{theatre}.json')), out, f'{src}/../models.json')


if __name__ == '__main__':
    main()
