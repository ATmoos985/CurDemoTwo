"""Extract the metric BOKE cutting patterns used by the garment examples.

Usage: python scripts/import-garment-dxf.py 1226.dxf 20148D.dxf 3129.dxf
The generated module contains normalized cut boundaries, grain and handed counts.
"""
import argparse
import json
import math
import re
from pathlib import Path


OUTPUT = Path(__file__).resolve().parents[1] / "src/main/resources/static/js/nesting/dxf-outlines.js"
SIZES = ("110", "120", "130", "140", "150", "160")


def entities(path):
    # A nongeometry annotation in 20148D contains a stray byte. Required labels below are checked.
    lines = path.read_bytes().decode("gb18030", errors="replace").splitlines()
    if len(lines) % 2:
        raise ValueError("Incomplete DXF group pair")
    record = {}
    for code, value in zip(lines[::2], lines[1::2]):
        code = int(code.strip())
        if code == 0 and record:
            yield record
            record = {}
        record[code] = value.strip()
    if record:
        yield record


def point_segment(point, a, b):
    dx, dy = b[0] - a[0], b[1] - a[1]
    if not (dx or dy):
        return math.dist(point, a)
    t = max(0, min(1, ((point[0] - a[0])*dx + (point[1] - a[1])*dy) / (dx*dx + dy*dy)))
    return math.hypot(point[0] - a[0] - t*dx, point[1] - a[1] - t*dy)


def simplify_chain(points, tolerance):
    if len(points) <= 2:
        return points
    distance, i = max((point_segment(p, points[0], points[-1]), i) for i, p in enumerate(points[1:-1], 1))
    if distance <= tolerance:
        return [points[0], points[-1]]
    return simplify_chain(points[:i+1], tolerance)[:-1] + simplify_chain(points[i:], tolerance)


def ring_area(points):
    return abs(sum(x*v - y*u for (x,y),(u,v) in zip(points, points[1:]+points[:1]))) / 2


def simple_ring(points):
    def turn(a, b, c):
        return (b[0]-a[0])*(c[1]-a[1]) - (b[1]-a[1])*(c[0]-a[0])

    edges = list(zip(points, points[1:]+points[:1]))
    if len(points) < 3 or len(set(points)) != len(points) or ring_area(points) == 0:
        return False
    for i, (a,b) in enumerate(edges):
        for j in range(i+2, len(edges)):
            if i == 0 and j == len(edges)-1:
                continue
            c,d = edges[j]
            if any(max(a[k],b[k]) < min(c[k],d[k]) or max(c[k],d[k]) < min(a[k],b[k]) for k in (0,1)):
                continue
            if turn(a,b,c)*turn(a,b,d) <= 0 and turn(c,d,a)*turn(c,d,b) <= 0:
                return False
    return True


def cut_ring(raw, grain):
    dx, dy = grain
    norm = math.hypot(dx, dy)
    if not norm:
        raise ValueError("Zero grain line")
    dx, dy = dx/norm, dy/norm
    # CAD is Y-up. Turn its directed grain toward the canvas's increasing roll length (+y).
    rotated = [(-dy*x + dx*y, dx*x + dy*y) for x,y in raw]
    origin_x, origin_y = min(x for x,y in rotated), min(y for x,y in rotated)
    points = []
    for x,y in rotated:
        p = (round(x-origin_x, 4), round(y-origin_y, 4))
        if not points or p != points[-1]:
            points.append(p)
    if points[-1] == points[0]:
        points.pop()
    if len(points) > 128 or not simple_ring(points):
        far = max(range(len(points)), key=lambda i: math.dist(points[i], points[0]))
        # Split a closed ring into two open arcs so the two RDP endpoints differ.
        for tolerance in (0.025, 0.05, 0.1, 0.15, 0.2):
            candidate = simplify_chain(points[:far+1], tolerance)[:-1] + simplify_chain(points[far:]+points[:1], tolerance)[:-1]
            if len(candidate) <= 128 and simple_ring(candidate):
                points = candidate
                break
        else:
            raise ValueError("Cut boundary exceeds shape contract or is self-intersecting")
    if abs(ring_area(points) - ring_area(raw)) > max(0.1, 0.0005*ring_area(raw)):
        raise ValueError("Cut boundary area changed by more than 0.05%")
    xmin, ymin = min(x for x,y in points), min(y for x,y in points)
    return [[round(x-xmin,4),round(y-ymin,4)] for x,y in points]


def read_piece(records):
    tags, materials, cuts, grains = {}, [], [], []
    current = None
    for r in records:
        kind, layer = r[0], r.get(8)
        if kind == "TEXT":
            key, _, value = r[1].partition(": ")
            if key == "Annotation" and value.startswith("Mat-"):
                materials.append(value)
            elif key in ("Piece Name", "Fabric", "Size", "Quantity"):
                tags[key] = value
        elif kind == "POLYLINE":
            current = None
            if layer == "1":
                if int(r.get(70, 0)) & 1 == 0:
                    raise ValueError("Open cutting boundary on layer 1")
                current = []
                cuts.append(current)
        elif kind == "VERTEX" and current is not None:
            if float(r.get(42, 0)) != 0:
                raise ValueError("Unflattened bulge on cutting boundary")
            current.append((float(r[10]),float(r[20])))
        elif kind == "SEQEND":
            current = None
        elif kind == "LINE" and layer == "7":
            grains.append((float(r[11])-float(r[10]),float(r[21])-float(r[20])))
    if len(cuts) != 1 or len(grains) != 1 or len(materials) != 1:
        raise ValueError("Expected one cutting boundary, grain and material annotation per pattern")
    match = re.fullmatch(r"Mat-([^()]+)\(L:(\d+)-R:(\d+)\)", materials[0])
    if not match or any("\ufffd" in tags[k] for k in ("Piece Name", "Fabric", "Size", "Quantity")):
        raise ValueError("Invalid material, handedness or piece label")
    code, left, right = match[1], int(match[2]), int(match[3])
    if [q for q in (left,right) if q] != [int(x) for x in tags["Quantity"].split(",")]:
        raise ValueError("Quantity conflicts with handedness annotation")
    return tags, code, left, right, cut_ring(cuts[0], grains[0])


def read_file(path):
    groups, used_blocks, inserts = {}, set(), []
    block = records = None
    metric = False
    for r in entities(path):
        if r[0] == "BLOCK":
            block, records = r[2], []
        elif r[0] == "ENDBLK":
            try:
                tags, code, left, right, ring = read_piece(records)
                source = tags["Piece Name"]
                name = source.rsplit("_", 1)[-1]
                if path.stem == "3129":
                    name = ("裤" if "3129 裤_" in source else "上衣") + " · " + name
                group = groups.setdefault(code, {"fabric":tags["Fabric"], "pieces":{}})
                piece = group["pieces"].setdefault(name, {"name":name,"left":left,"right":right,"sizes":{}})
                if group["fabric"] != tags["Fabric"] or (left,right) != (piece["left"],piece["right"]) or tags["Size"] in piece["sizes"]:
                    raise ValueError("Inconsistent material, count or duplicate size")
                piece["sizes"][tags["Size"]] = ring
            except (KeyError, ValueError) as e:
                raise ValueError(f"{path.name} / {block}: {e}") from e
            used_blocks.add(block)
            block = records = None
        elif block is not None:
            records.append(r)
        elif r[0] == "TEXT" and r.get(1) == "Units: METRIC":
            metric = True
        elif r[0] == "INSERT":
            if any(float(r.get(k, default)) != default for k,default in ((41,1),(42,1),(43,1),(50,0))):
                raise ValueError("Unexpected INSERT scale or rotation")
            inserts.append(r[2])
    if not metric or not groups or sorted(used_blocks) != sorted(inserts):
        raise ValueError(f"{path.name}: missing unit or unmatched pattern references")
    for group in groups.values():
        for part in group["pieces"].values():
            if set(part["sizes"]) != set(SIZES):
                raise ValueError(f"{path.name}: missing grades for {part['name']}")
        group["pieces"] = list(group["pieces"].values())
    return groups


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("files", type=Path, nargs=3)
    parser.add_argument("--output", type=Path, default=OUTPUT)
    args = parser.parse_args()
    if {p.stem for p in args.files} != {"1226","20148D","3129"}:
        parser.error("Expected 1226.dxf, 20148D.dxf and 3129.dxf")
    lines = ["// Generated by scripts/import-garment-dxf.py from BOKE metric cutting layers.", "export const DXF_OUTLINES = {"]
    compact = lambda value: json.dumps(value, ensure_ascii=False, separators=(",",":"))
    for path in sorted(args.files):
        lines.append(f'    "{path.stem}": {{')
        for code, group in sorted(read_file(path).items()):
            lines.append(f'        {compact(code)}: {{fabric:{compact(group["fabric"])}, pieces:[')
            for part in group["pieces"]:
                lines.append(f'            {{name:{compact(part["name"])}, left:{part["left"]}, right:{part["right"]}, sizes:{{')
                for size, ring in part["sizes"].items():
                    lines.append(f'                "{size}":{compact(ring)},')
                lines.append("            }},")
            lines.append("        ]},")
        lines.append("    },")
    args.output.write_text("\n".join(lines+["};",""]), encoding="utf-8", newline="\n")


if __name__ == "__main__":
    main()
