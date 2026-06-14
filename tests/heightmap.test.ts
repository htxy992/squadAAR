import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeGrayPNG16, decodePNGGray, fieldFromHeights } from '../src/maps/heightmap.js';
import { terrainHeightAt } from '../src/analysis/ballistics.js';

test('PNG16 encode -> decode round-trips heights', () => {
  const W = 8, H = 8;
  const data = new Float64Array(W * H);
  for (let i = 0; i < data.length; i++) data[i] = i / (data.length - 1);
  const png = encodeGrayPNG16(W, H, data);
  const dec = decodePNGGray(png);
  assert.equal(dec.width, W);
  assert.equal(dec.height, H);
  for (let i = 0; i < data.length; i++) assert.ok(Math.abs(dec.data[i] - data[i]) < 1e-3);
});

test('fieldFromHeights scales to metres and aligns (north=top)', () => {
  const W = 16, H = 16;
  const data = new Float64Array(W * H);
  // ramp from 0 at top (north) to 1 at bottom (south)
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) data[y * W + x] = y / (H - 1);
  const bounds = { minX: -1000, minY: -1000, maxX: 1000, maxY: 1000 };
  const field = fieldFromHeights({ width: W, height: H, data }, bounds, 0, 100, 32);
  // top of image (north, maxY) should be ~0 m; bottom (south, minY) ~100 m
  const north = terrainHeightAt(field, 0, 990) / 100;
  const south = terrainHeightAt(field, 0, -990) / 100;
  assert.ok(north < 15, `north low, got ${north}`);
  assert.ok(south > 85, `south high, got ${south}`);
  assert.equal(field.coverage, 1);
});
