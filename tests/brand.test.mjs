import { test } from "node:test";
import assert from "node:assert/strict";
import {
  GUANLAN_BRAND,
  GUANLAN_MARK_SVG,
  guanlanBrandAsset,
  renderGuanlanBrandPage,
  renderGuanlanHomePage,
  renderGuanlanResultPage,
} from "../dist/brand.mjs";

test("brand contract keeps one Guanlan identity across home, kit and assets", () => {
  assert.equal(GUANLAN_BRAND.name, "观澜 Guanlan");
  assert.equal(GUANLAN_BRAND.tagline, "观世界 · 识时势");
  assert.match(GUANLAN_MARK_SVG, /<svg/);
  assert.match(GUANLAN_MARK_SVG, /远山与水面/);

  const home = renderGuanlanHomePage();
  assert.match(home, /观澜/);
  assert.match(home, /Guanlan/);
  assert.match(home, /观世界 · 识时势/);
  assert.match(home, /href="\/auth\/start"/);
  assert.match(home, /href="\/brand"/);
  assert.doesNotMatch(home, /(?:src|href)="https?:\/\//);
  assert.doesNotMatch(home, /<script\b/i);

  const kit = renderGuanlanBrandPage();
  assert.match(kit, /BRAND SYSTEM/);
  assert.match(kit, /guanlan-mark\.svg/);
  assert.match(kit, /tokens\.json/);

  const icon = guanlanBrandAsset("guanlan-mark.svg");
  assert.ok(icon);
  assert.equal(icon.contentType, "image/svg+xml; charset=utf-8");
  assert.equal(icon.body, GUANLAN_MARK_SVG);

  const tokens = guanlanBrandAsset("tokens.json");
  assert.ok(tokens);
  assert.equal(tokens.contentType, "application/json; charset=utf-8");
  assert.deepEqual(JSON.parse(tokens.body), GUANLAN_BRAND);
  assert.equal(guanlanBrandAsset("../secret"), null);
});

test("OAuth result renderer escapes untrusted text and keeps the branded recovery path", () => {
  const html = renderGuanlanResultPage({
    kind: "error",
    title: '<img src=x onerror="boom">',
    message: "<script>boom()</script>",
    detail: 'bad"><svg onload=boom()>',
    actionHref: 'javascript:alert("boom")',
    actionLabel: "<b>retry</b>",
  });

  assert.equal(html.includes("<script>"), false);
  assert.equal(html.includes("<img src=x"), false);
  assert.equal(html.includes("<svg onload"), false);
  assert.match(html, /&lt;script&gt;boom\(\)&lt;\/script&gt;/);
  assert.match(html, /&lt;img src=x onerror=&quot;boom&quot;&gt;/);
  assert.match(html, /bad&quot;&gt;&lt;svg onload=boom\(\)&gt;/);
  assert.match(html, /javascript:alert\(&quot;boom&quot;\)/);
  assert.match(html, /&lt;b&gt;retry&lt;\/b&gt;/);
  assert.match(html, /href="\/brand"/);
});
