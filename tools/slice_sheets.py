"""会議探偵 画像セットの切り出し。

tools/raw/<jobId>.png (生画像) を読み、以下を出力する:
  - 背景:     public/assets/bg/<id>.jpg      (JPEG q88, 元の寸法のまま)
  - 人物シート: public/assets/chars/<id>.png  (透過・トリミング・高さ上限 900px)
  - 道具シート: public/assets/items/<id>.png  (透過・トリミング・長辺上限 420px)
  - public/assets/manifest.json

人物・道具は、アルファ > 24 の画素をマスクにして少し膨張させ、連結成分で切り分ける。
成分数が期待数と合わないときは等分グリッドで切り、各セルのアルファ bbox でトリミングする。

使い方:  python tools/slice_sheets.py
"""

from __future__ import annotations

import json
import sys
from collections import deque
from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
TOOLS = ROOT / "tools"
RAW = TOOLS / "raw"
ASSETS = ROOT / "public" / "assets"

ALPHA_THRESHOLD = 24
DILATE_SIZE = 7          # MaxFilter のサイズ（奇数）。湯気や小さな破片をつなぐ
MIN_AREA_RATIO = 0.02    # 最大成分の面積に対してこれ未満はノイズ扱い
MIN_AREA_PX = 150
MERGE_GAP_PX = 60        # 余分な小片をこの距離以内なら最寄りの本体に併合する
MARGIN = 8
CHAR_MAX_H = 900
ITEM_MAX_LONG = 420
LANCZOS = Image.Resampling.LANCZOS

warnings: list[str] = []


def warn(msg: str) -> None:
    warnings.append(msg)
    print(f"  WARNING: {msg}", flush=True)


def label_components(mask: np.ndarray) -> list[np.ndarray]:
    """mask (bool, HxW) を膨張させてから連結成分を求め、各成分の元マスク画素の flat index のリストを返す。"""
    h, w = mask.shape
    dil_img = Image.fromarray((mask * 255).astype(np.uint8)).filter(ImageFilter.MaxFilter(DILATE_SIZE))
    dil = np.asarray(dil_img) > 0
    flat_dil = dil.ravel()
    visited = bytearray(h * w)
    fg_idx = np.flatnonzero(flat_dil).tolist()

    comps: list[np.ndarray] = []
    for start in fg_idx:
        if visited[start]:
            continue
        visited[start] = 1
        stack = [start]
        members = []
        while stack:
            p = stack.pop()
            members.append(p)
            y, x = divmod(p, w)
            if x > 0:
                q = p - 1
                if flat_dil[q] and not visited[q]:
                    visited[q] = 1
                    stack.append(q)
            if x < w - 1:
                q = p + 1
                if flat_dil[q] and not visited[q]:
                    visited[q] = 1
                    stack.append(q)
            if y > 0:
                q = p - w
                if flat_dil[q] and not visited[q]:
                    visited[q] = 1
                    stack.append(q)
            if y < h - 1:
                q = p + w
                if flat_dil[q] and not visited[q]:
                    visited[q] = 1
                    stack.append(q)
        comps.append(np.asarray(members, dtype=np.int64))

    # 各成分について元マスクの画素だけを残す
    flat_mask = mask.ravel()
    result = []
    for members in comps:
        orig = members[flat_mask[members]]
        if orig.size:
            result.append(orig)
    return result


def bbox_of(flat_idx: np.ndarray, w: int) -> tuple[int, int, int, int]:
    ys, xs = np.divmod(flat_idx, w)
    return int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1


def box_gap(a: tuple[int, int, int, int], b: tuple[int, int, int, int]) -> float:
    dx = max(0, max(a[0], b[0]) - min(a[2], b[2]))
    dy = max(0, max(a[1], b[1]) - min(a[3], b[3]))
    return float((dx * dx + dy * dy) ** 0.5)


def crop_owned(img: Image.Image, mask: np.ndarray, labels: np.ndarray, k: int,
               box: tuple[int, int, int, int]) -> Image.Image:
    """ラベル k の画素だけを残して切り出す（他の成分の画素は透明化、余白は 8px）。"""
    W, H = img.size
    x0, y0, x1, y1 = box
    x0 = max(0, x0 - MARGIN)
    y0 = max(0, y0 - MARGIN)
    x1 = min(W, x1 + MARGIN)
    y1 = min(H, y1 + MARGIN)
    crop = img.crop((x0, y0, x1, y1))
    lab = labels[y0:y1, x0:x1]
    m = mask[y0:y1, x0:x1]
    keep = (lab == k) | (~m)
    arr = np.asarray(crop).copy()
    arr[..., 3] = np.where(keep, arr[..., 3], 0)
    return Image.fromarray(arr, "RGBA")


def crop_with_margin(img: Image.Image, box: tuple[int, int, int, int]) -> Image.Image:
    W, H = img.size
    x0, y0, x1, y1 = box
    x0 = max(0, x0 - MARGIN)
    y0 = max(0, y0 - MARGIN)
    x1 = min(W, x1 + MARGIN)
    y1 = min(H, y1 + MARGIN)
    return img.crop((x0, y0, x1, y1))


def alpha_bbox_in(img: Image.Image, box: tuple[int, int, int, int]) -> tuple[int, int, int, int] | None:
    """img の box 内で、アルファ > 閾値の画素の bbox（img 座標）を返す。無ければ None。"""
    x0, y0, x1, y1 = box
    a = np.asarray(img.split()[3].crop(box)) > ALPHA_THRESHOLD
    ys, xs = np.nonzero(a)
    if xs.size == 0:
        return None
    return x0 + int(xs.min()), y0 + int(ys.min()), x0 + int(xs.max()) + 1, y0 + int(ys.max()) + 1


def grid_cells(img: Image.Image, rows: int, cols: int) -> list[tuple[int, int, int, int]]:
    W, H = img.size
    cells = []
    for r in range(rows):
        for c in range(cols):
            cells.append((c * W // cols, r * H // rows, (c + 1) * W // cols, (r + 1) * H // rows))
    return cells


def slice_sheet(img: Image.Image, expected: int, rows: int, cols: int, order: str, job_id: str) -> list[Image.Image]:
    """成分で切り出し、期待数に満たなければ等分グリッドにフォールバック。
    期待数より多い成分は、面積上位を本体とし、近い小片（剥がれた小物など）は本体に併合する。
    order: 'x' は x 順、'grid' は行→列順（連結成分は重心 y で行に分けてから x 順）。"""
    alpha = np.asarray(img.split()[3])
    mask = alpha > ALPHA_THRESHOLD
    h, w = mask.shape

    comps = label_components(mask)
    areas = [int(c.size) for c in comps]
    if areas:
        max_area = max(areas)
        thr = max(MIN_AREA_PX, MIN_AREA_RATIO * max_area)
        comps = [c for c, a in zip(comps, areas) if a >= thr]
    print(f"  成分数 (ノイズ除去後): {len(comps)} / 期待 {expected}", flush=True)

    if len(comps) < expected:
        warn(f"{job_id}: 成分 {len(comps)} < 期待 {expected}。等分グリッドで切り直します")
        return grid_slice(img, rows, cols, job_id)

    comps.sort(key=lambda c: -int(c.size))
    anchors = comps[:expected]
    extras = comps[expected:]

    labels = np.full(h * w, -1, dtype=np.int32)
    anchor_boxes = []
    for k, c in enumerate(anchors):
        labels[c] = k
        anchor_boxes.append(bbox_of(c, w))
    for c in extras:
        eb = bbox_of(c, w)
        dists = [box_gap(eb, ab) for ab in anchor_boxes]
        j = int(np.argmin(dists))
        if dists[j] <= MERGE_GAP_PX:
            labels[c] = j
            print(f"  小片を成分 {j} に併合 (距離 {dists[j]:.0f}px, 画素 {c.size})", flush=True)
        else:
            warn(f"{job_id}: 余分な成分を破棄 (面積 {c.size}px, 最寄り距離 {dists[j]:.0f}px)")
    if extras:
        print(f"  余分な成分 {len(extras)} 個を処理しました", flush=True)

    labels = labels.reshape(h, w)
    # 併合後のボックスを再計算
    final = []
    for k in range(expected):
        members = np.flatnonzero(labels.ravel() == k)
        final.append((bbox_of(members, w), k))

    if order == "x":
        final.sort(key=lambda t: (t[0][0] + t[0][2]) / 2)
    else:
        final.sort(key=lambda t: (t[0][1] + t[0][3]) / 2)
        out = []
        for r in range(rows):
            row = final[r * cols:(r + 1) * cols]
            row.sort(key=lambda t: (t[0][0] + t[0][2]) / 2)
            out.extend(row)
        final = out

    return [crop_owned(img, mask, labels, k, box) for box, k in final]


def grid_slice(img: Image.Image, rows: int, cols: int, job_id: str) -> list[Image.Image]:
    result: list[Image.Image] = []
    for i, cell in enumerate(grid_cells(img, rows, cols)):
        bb = alpha_bbox_in(img, cell)
        if bb is None:
            warn(f"{job_id}: セル {i + 1} が空でした")
            result.append(Image.new("RGBA", (1, 1), (0, 0, 0, 0)))
            continue
        result.append(crop_with_margin(img, bb))
    return result


def fit(img: Image.Image, max_side: int | None = None, max_h: int | None = None) -> Image.Image:
    w, h = img.size
    if max_h is not None and h > max_h:
        s = max_h / h
        return img.resize((max(1, round(w * s)), max_h), LANCZOS)
    if max_side is not None and max(w, h) > max_side:
        s = max_side / max(w, h)
        return img.resize((max(1, round(w * s)), max(1, round(h * s))), LANCZOS)
    return img


def load_raw(job_id: str) -> Image.Image | None:
    p = RAW / f"{job_id}.png"
    if not p.exists():
        warn(f"{job_id}: 生画像がありません ({p.name})。このシートは manifest から除外します")
        return None
    return Image.open(p).convert("RGBA")


def main() -> int:
    spec = json.loads((TOOLS / "asset-spec.json").read_text(encoding="utf-8"))
    for sub in ("bg", "chars", "items"):
        (ASSETS / sub).mkdir(parents=True, exist_ok=True)

    manifest = {
        "version": spec.get("version", 1),
        "themes": spec["themes"],
        "backgrounds": [],
        "characters": [],
        "items": [],
    }

    for job in spec["jobs"]:
        kind = job["kind"]
        job_id = job["jobId"]
        print(f"[{job_id}] {kind}", flush=True)

        if kind == "background":
            raw = load_raw(job_id)
            if raw is None:
                continue
            rgb = raw.convert("RGB")
            meta = job["meta"]
            out = ASSETS / "bg" / f"{meta['id']}.jpg"
            rgb.save(out, "JPEG", quality=88, optimize=True)
            manifest["backgrounds"].append({
                "id": meta["id"],
                "theme": meta["theme"],
                "name": meta["name"],
                "file": f"assets/bg/{meta['id']}.jpg",
                "width": rgb.size[0],
                "height": rgb.size[1],
                "floorY": meta["floorY"],
            })
            print(f"  -> {out.name} {rgb.size}", flush=True)

        elif kind == "characters":
            raw = load_raw(job_id)
            if raw is None:
                continue
            pieces = slice_sheet(raw, expected=len(job["meta"]), rows=1, cols=len(job["meta"]), order="x", job_id=job_id)
            for meta, piece in zip(job["meta"], pieces):
                piece = fit(piece, max_h=CHAR_MAX_H)
                out = ASSETS / "chars" / f"{meta['id']}.png"
                piece.save(out, "PNG", optimize=True)
                manifest["characters"].append({
                    "id": meta["id"],
                    "label": meta["label"],
                    "expression": meta["expression"],
                    "themes": meta["themes"],
                    "file": f"assets/chars/{meta['id']}.png",
                    "width": piece.size[0],
                    "height": piece.size[1],
                })
                print(f"  -> {out.name} {piece.size}", flush=True)

        elif kind == "items":
            raw = load_raw(job_id)
            if raw is None:
                continue
            pieces = slice_sheet(raw, expected=len(job["meta"]), rows=3, cols=3, order="grid", job_id=job_id)
            for meta, piece in zip(job["meta"], pieces):
                piece = fit(piece, max_side=ITEM_MAX_LONG)
                out = ASSETS / "items" / f"{meta['id']}.png"
                piece.save(out, "PNG", optimize=True)
                manifest["items"].append({
                    "id": meta["id"],
                    "label": meta["label"],
                    "themes": meta["themes"],
                    "file": f"assets/items/{meta['id']}.png",
                    "width": piece.size[0],
                    "height": piece.size[1],
                })
                print(f"  -> {out.name} {piece.size}", flush=True)
        else:
            warn(f"{job_id}: 未知の kind {kind}")

    (ASSETS / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(
        f"manifest: themes={len(manifest['themes'])} backgrounds={len(manifest['backgrounds'])} "
        f"characters={len(manifest['characters'])} items={len(manifest['items'])}",
        flush=True,
    )
    if warnings:
        print(f"警告 {len(warnings)} 件:", flush=True)
        for w in warnings:
            print(f"  - {w}", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
