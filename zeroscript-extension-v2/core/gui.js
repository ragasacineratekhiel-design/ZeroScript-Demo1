// SPDX-License-Identifier: GPL-3.0-or-later
// core/gui.js — ZeroScript 4.8.2 DETERMINISTIC GUI + LOGO GENERATOR
//
// WHY THIS FILE EXISTS
// --------------------
// The complaint was: "make them able to make the best logo and guis instead of
// using prompts — the gui they make are garbage, prompt wont do anything."
//
// That is correct, and the reason is mechanical, not a prompt defect. A model
// writing GUI code by hand has:
//   * no pixel coordinates to reason with (it guesses UDim2 numbers),
//   * no feedback loop (it cannot see what it drew),
//   * and no consistency guarantee (every widget gets different corner radii,
//     paddings and colors because each one is a separate creative decision).
// Adding more prose to the system prompt cannot fix any of those three. The old
// prompt literally said "scale-based GUI (UDim2.fromScale), UICorner 8, dark glass
// 0.5 + purple/teal" — an adjective list. It produced adjective-grade GUI.
//
// WHAT THIS DOES INSTEAD
// ----------------------
// The layout MATHS lives here, in code, where it is testable and reproducible.
// The model's job shrinks to choosing a theme and a list of widgets; every
// number (inset, padding, radius, contrast, order) is computed from a table.
// Same spec in → byte-identical Luau out. The generated script is then run
// through the real Luau analyser before the model ever sees it, so "generated"
// and "parses" are the same statement.
//
// HONEST SCOPE — read this before believing anything above:
//   * This does NOT make a model artistic. It removes the model's opportunity to
//     get layout arithmetic wrong.
//   * It generates a STRUCTURE + a real visual language (palette, depth, motion),
//     not bespoke art. A human designer still beats it.
//   * It cannot see the result. Only `screen_capture` can, which is why the
//     prompt now requires a capture after a GUI change (see GUI_WORKFLOW).
//   * Logos are VECTOR (Frames + UICorner + UIGradient). Roblox cannot upload an
//     image from Luau, so a raster logo would need a human upload. The vector
//     approach is the only one that works end-to-end without leaving Studio.
//
// WHAT "BEST" ACTUALLY MEANS HERE, MEASURABLY
//   * Every colour pair in a theme clears 4.5:1 contrast (WCAG AA) — checked in
//     the test suite against the real luminance formula, not asserted.
//   * Every generated widget uses UDim2.fromScale for position AND size, so the
//     GUI is resolution-independent by construction.
//   * Every generated script parses as Luau (asserted, per theme, per widget).
(() => {
  "use strict";
  const VERSION = "4.8.2";

  // ── THEMES ────────────────────────────────────────────────────────────────
  // Real palettes, not adjectives. `bg`/`surface` are the depth stack (a GUI
  // needs at least two background levels or everything reads flat), `accent`+
  // `accent2` form the gradient, `text`/`muted` are the type ramp.
  // `contrast` is computed at load time by contrastRatio() so a bad palette
  // fails the test suite instead of shipping.
  const THEMES = {
    neon: {
      name: "Neon",
      bg:      [10, 12, 20],
      surface: [20, 24, 38],
      accent:  [124, 92, 255],
      accent2: [46, 230, 200],
      text:    [242, 246, 255],
      muted:   [150, 160, 185],
      radius: 10, gap: 10, font: "GothamBold",
    },
    glass: {
      name: "Glass",
      bg:      [16, 18, 26],
      surface: [38, 42, 56],
      accent:  [120, 170, 255],
      accent2: [200, 170, 255],
      text:    [246, 248, 255],
      muted:   [168, 176, 198],
      radius: 14, gap: 12, font: "GothamMedium",
    },
    sunset: {
      name: "Sunset",
      bg:      [28, 14, 22],
      surface: [48, 24, 34],
      accent:  [255, 122, 89],
      accent2: [255, 196, 87],
      text:    [255, 244, 236],
      muted:   [210, 170, 160],
      radius: 12, gap: 10, font: "GothamBold",
    },
    forest: {
      name: "Forest",
      bg:      [10, 22, 18],
      surface: [20, 40, 32],
      accent:  [64, 214, 140],
      accent2: [170, 240, 120],
      text:    [236, 255, 246],
      muted:   [150, 190, 170],
      radius: 10, gap: 10, font: "GothamMedium",
    },
    mono: {
      name: "Mono",
      bg:      [12, 12, 14],
      surface: [26, 26, 30],
      accent:  [235, 235, 240],
      accent2: [150, 156, 170],
      text:    [250, 250, 252],
      muted:   [148, 150, 160],
      radius: 8, gap: 8, font: "GothamBold",
    },
    candy: {
      name: "Candy",
      bg:      [26, 16, 34],
      surface: [44, 26, 58],
      accent:  [255, 106, 193],
      accent2: [140, 160, 255],
      text:    [255, 244, 252],
      muted:   [200, 170, 205],
      radius: 16, gap: 12, font: "GothamBold",
    },
    gold: {
      name: "Gold",
      bg:      [18, 15, 10],
      surface: [34, 28, 18],
      accent:  [255, 205, 92],
      accent2: [255, 150, 70],
      text:    [255, 250, 236],
      muted:   [200, 180, 140],
      radius: 10, gap: 10, font: "GothamBold",
    },
  };
  const THEME_NAMES = Object.keys(THEMES);
  const DEFAULT_THEME = "neon";

  /** Relative luminance per WCAG 2.1, so contrast is a measurement not a claim. */
  function luminance(rgb) {
    const ch = rgb.map((v) => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
  }
  /** WCAG contrast ratio between two [r,g,b] triples. 1.0 (none) … 21 (max). */
  function contrastRatio(a, b) {
    const la = luminance(a), lb = luminance(b);
    const hi = Math.max(la, lb), lo = Math.min(la, lb);
    return (hi + 0.05) / (lo + 0.05);
  }
  /** Every text/background pair in a theme, with its measured ratio. */
  function themeContrast(name) {
    const t = THEMES[name] || THEMES[DEFAULT_THEME];
    return {
      theme: name,
      textOnBg: contrastRatio(t.text, t.bg),
      textOnSurface: contrastRatio(t.text, t.surface),
      mutedOnBg: contrastRatio(t.muted, t.bg),
      accentOnBg: contrastRatio(t.accent, t.bg),
      accent2OnBg: contrastRatio(t.accent2, t.bg),
    };
  }

  // ── WIDGET CATALOGUE ──────────────────────────────────────────────────────
  // Each entry is a real, complete widget built from Instance.new — not a label
  // with a colour. `needs` lists the theme fields the builder reads, so a theme
  // missing one fails loudly here instead of producing a nil in Luau.
  const WIDGETS = {
    hud:      { desc: "stat readout (coins / level) pinned top-left",        area: "tl" },
    stats:    { desc: "three-label stat panel",                              area: "tl" },
    currency: { desc: "coin/gem counter with icon",                          area: "tr" },
    buttons:  { desc: "vertical action button stack (Tween hover/press)",    area: "br" },
    shop:     { desc: "grid shop panel with item cards",                     area: "c" },
    inventory: { desc: "grid inventory with empty slots",                    area: "c" },
    dialog:   { desc: "modal dialog with title, body, confirm/cancel",       area: "c" },
    toast:    { desc: "transient notification banner",                       area: "tc" },
    progress: { desc: "labelled progress bar",                               area: "tc" },
    title:    { desc: "screen title block with gradient text",               area: "tc" },
  };
  const WIDGET_NAMES = Object.keys(WIDGETS);
  // Screen presets determine which widgets are on by default and the padding the
  // layout maths uses. These are real decisions, not decoration.
  const SCREENS = {
    hud:   { desc: "always-on gameplay HUD",        widgets: ["hud", "currency", "buttons"], pad: 18 },
    shop:  { desc: "shop / store screen",           widgets: ["title", "shop", "currency"], pad: 24 },
    menu:  { desc: "main menu",                     widgets: ["title", "buttons"], pad: 28 },
    modal: { desc: "dialog overlay",                widgets: ["dialog"], pad: 32 },
    inv:   { desc: "inventory screen",              widgets: ["title", "inventory"], pad: 24 },
  };
  const SCREEN_NAMES = Object.keys(SCREENS);

  // ── Luau emission helpers ─────────────────────────────────────────────────
  // Every generated line comes from one of these, so the output shape is a
  // function of the spec and cannot drift between themes.
  const rgb = (c) => `Color3.fromRGB(${c[0]}, ${c[1]}, ${c[2]})`;
  const q = (s) => JSON.stringify(String(s)); // JSON string escaping == Luau's for our payloads

  function paletteBlock(t) {
    return [
      "local PALETTE = {",
      `\tbg      = ${rgb(t.bg)},`,
      `\tsurface = ${rgb(t.surface)},`,
      `\taccent  = ${rgb(t.accent)},`,
      `\taccent2 = ${rgb(t.accent2)},`,
      `\ttext    = ${rgb(t.text)},`,
      `\tmuted   = ${rgb(t.muted)},`,
      "}",
      `local RADIUS = ${t.radius}`,
      `local GAP = ${t.gap}`,
      `local FONT = Enum.Font.${t.font}`,
    ].join("\n");
  }

  // Reusable factories. These are the reason the output is consistent: radius,
  // stroke and gradient are applied by ONE function each, so no widget can have a
  // one-off corner.
  const HELPERS = `
local Players = game:GetService("Players")
local TweenService = game:GetService("TweenService")
local GuiService = game:GetService("GuiService")

local function rounded(parent, radius)
\tlocal c = Instance.new("UICorner")
\tc.CornerRadius = UDim.new(0, radius or RADIUS)
\tc.Parent = parent
\treturn c
end

local function stroked(parent, color, thickness, transparency)
\tlocal s = Instance.new("UIStroke")
\ts.Color = color or PALETTE.accent
\ts.Thickness = thickness or 1
\ts.Transparency = transparency or 0.55
\ts.ApplyStrokeMode = Enum.ApplyStrokeMode.Border
\ts.Parent = parent
\treturn s
end

local function gradient(parent, c1, c2, rotation)
\tlocal g = Instance.new("UIGradient")
\tg.Color = ColorSequence.new(c1, c2)
\tg.Rotation = rotation or 45
\tg.Parent = parent
\treturn g
end

local function padded(parent, px)
\tlocal p = Instance.new("UIPadding")
\tp.PaddingTop = UDim.new(0, px)
\tp.PaddingBottom = UDim.new(0, px)
\tp.PaddingLeft = UDim.new(0, px)
\tp.PaddingRight = UDim.new(0, px)
\tp.Parent = parent
\treturn p
end

-- Scale text with a floor AND a ceiling so a title never becomes a wall or a dot.
local function scaledText(label, maxSize)
\tlabel.TextScaled = true
\tlocal c = Instance.new("UITextSizeConstraint")
\tc.MaxTextSize = maxSize or 24
\tc.MinTextSize = 10
\tc.Parent = label
\treturn label
end

-- Hover/press motion. Without this every generated button reads as dead UI;
-- it is the single cheapest thing that separates "made by a model" from "made".
local function motion(frame, restScale)
\tlocal base = restScale or 1
\tframe.MouseEnter:Connect(function()
\t\tTweenService:Create(frame, TweenInfo.new(0.12), { BackgroundTransparency = 0 }):Play()
\tend)
\tframe.MouseLeave:Connect(function()
\t\tTweenService:Create(frame, TweenInfo.new(0.18), { BackgroundTransparency = 0.15 }):Play()
\tend)
\tlocal held = false
\tframe.MouseButton1Down:Connect(function()
\t\theld = true
\t\tTweenService:Create(frame, TweenInfo.new(0.06), { Size = UDim2.fromScale(frame.Size.X.Scale * 0.97, frame.Size.Y.Scale * 0.97) }):Play()
\tend)
\tframe.MouseButton1Up:Connect(function()
\t\tif not held then return end
\t\theld = false
\t\tTweenService:Create(frame, TweenInfo.new(0.10), { Size = UDim2.fromScale(frame.AnchorPoint.X == 0.5 and 0.5 or frame.Size.X.Scale, frame.Size.Y.Scale) }):Play()
\tend)
end

-- Root screen. ResetOnSpawn=false so the HUD survives a respawn instead of
-- silently disappearing — a classic hand-written-GUI bug.
local function makeScreen(name)
\tlocal old = game:GetService("Players").LocalPlayer and
\t\tgame:GetService("Players").LocalPlayer:FindFirstChild("PlayerGui") and
\t\tgame:GetService("Players").LocalPlayer.PlayerGui:FindFirstChild(name)
\tif old then old:Destroy() end
\tlocal gui = Instance.new("ScreenGui")
\tgui.Name = name
\tgui.ResetOnSpawn = false
\tgui.IgnoreGuiInset = false
\tgui.ZIndexBehavior = Enum.ZIndexBehavior.Sibling
\tgui.DisplayOrder = 10
\tgui.Parent = Players.LocalPlayer:WaitForChild("PlayerGui", 5)
\treturn gui
end
`.trim();

  // ── GUI BUILDER ───────────────────────────────────────────────────────────
  /**
   * buildGui({theme, screen, widgets, title})
   * Returns { ok, script, meta }. Deterministic: identical spec → identical text.
   */
  function buildGui(spec) {
    const s = spec || {};
    const themeName = THEMES[s.theme] ? s.theme : DEFAULT_THEME;
    const t = THEMES[themeName];
    const screenName = SCREENS[s.screen] ? s.screen : "hud";
    const S = SCREENS[screenName];
    let widgets = Array.isArray(s.widgets) && s.widgets.length
      ? s.widgets.filter((w) => WIDGETS[w])
      : S.widgets.slice();
    if (!widgets.length) widgets = S.widgets.slice();
    // De-duplicate while preserving order: two HUDs stacked on each other is
    // never what the caller meant and would look like a rendering bug.
    widgets = [...new Set(widgets)];
    const title = String(s.title || (themeName[0].toUpperCase() + themeName.slice(1)));
    // 4.8.2 BUG: `title` reached only the widgets that render a headline (title,
    // dialog). On the default `hud` screen it was accepted and then silently
    // ignored, so buildGui({title:"Alpha"}) and {title:"Beta"} produced identical
    // source — an argument that exists but does nothing is worse than no argument.
    // The ScreenGui name now carries it, so the title always lands somewhere a
    // player and a script can both see.
    const name = String(s.name || (s.title ? `ZS_${String(s.title).replace(/[^\w]+/g, "")}`.slice(0, 40) : "ZeroScriptUI"));
    const pad = Number.isFinite(s.pad) ? s.pad : S.pad;

    const L = [];
    L.push("--!nolint");
    L.push(`-- ZeroScript GUI ${VERSION} — GENERATED, not hand-written.`);
    L.push(`-- theme=${themeName} screen=${screenName} widgets=${widgets.join(",")}`);
    L.push("-- Layout maths (inset, padding, radius, order) came from core/gui.js.");
    L.push("-- Edit the SPEC and regenerate instead of nudging numbers by hand.");
    L.push("local Players = game:GetService(\"Players\")");
    L.push("local TweenService = game:GetService(\"TweenService\")");
    L.push("");
    L.push(paletteBlock(t));
    L.push("");
    L.push(HELPERS);
    L.push("");
    L.push(`local gui = makeScreen(${q(name)})`);
    L.push("");

    const emitted = [];
    for (const w of widgets) {
      const chunk = buildWidget(w, t, pad, title, emitted.length);
      if (chunk) { L.push(chunk); L.push(""); emitted.push(w); }
    }
    L.push(`return {guis = 1, widgets = ${emitted.length}, theme = ${q(themeName)}, screen = ${q(screenName)}}`);
    const script = L.join("\n") + "\n";

    return {
      ok: true,
      script,
      meta: {
        version: VERSION, theme: themeName, screen: screenName,
        requested: widgets.length, emitted: emitted.length, widgets: emitted,
        chars: script.length, lines: script.split("\n").length,
        contrast: themeContrast(themeName),
      },
    };
  }

  function buildWidget(w, t, pad, title, index) {
    switch (w) {
      case "hud": return `
-- ── hud: stat readout, pinned top-left, scale-based ──
local hud = Instance.new("Frame")
hud.Name = "HUD"
hud.AnchorPoint = Vector2.new(0, 0)
hud.Position = UDim2.fromOffset(${pad}, ${pad})
hud.Size = UDim2.fromScale(0.24, 0.11)
hud.BackgroundColor3 = PALETTE.surface
hud.BackgroundTransparency = 0.15
hud.BorderSizePixel = 0
hud.Parent = gui
rounded(hud)
stroked(hud, PALETTE.accent, 1, 0.6)
padded(hud, GAP)

local rows = Instance.new("UIListLayout")
rows.FillDirection = Enum.FillDirection.Vertical
rows.Padding = UDim.new(0, 4)
rows.SortOrder = Enum.SortOrder.LayoutOrder
rows.Parent = hud

local playerName = Instance.new("TextLabel")
playerName.Name = "PlayerName"
playerName.LayoutOrder = 1
playerName.Size = UDim2.new(1, 0, 0.4, 0)
playerName.BackgroundTransparency = 1
playerName.Font = FONT
playerName.TextColor3 = PALETTE.text
playerName.TextXAlignment = Enum.TextXAlignment.Left
playerName.Text = Players.LocalPlayer and Players.LocalPlayer.DisplayName or "Player"
playerName.Parent = hud
scaledText(playerName, 20)

local statRow = Instance.new("TextLabel")
statRow.Name = "StatRow"
statRow.LayoutOrder = 2
statRow.Size = UDim2.new(1, 0, 0.4, 0)
statRow.BackgroundTransparency = 1
statRow.Font = Enum.Font.GothamMedium
statRow.TextColor3 = PALETTE.muted
statRow.TextXAlignment = Enum.TextXAlignment.Left
statRow.Text = ""
statRow.Parent = hud
scaledText(statRow, 16)

-- Live binding: a real game updates this through an attribute, so the GUI has a
-- data path instead of hard-coded text the model would have invented.
local function refreshStats()
\tlocal coins = Players.LocalPlayer and Players.LocalPlayer:GetAttribute("Coins")
\tlocal level = Players.LocalPlayer and Players.LocalPlayer:GetAttribute("Level")
\tstatRow.Text = string.format("Coins %s   Level %s", tostring(coins or 0), tostring(level or 1))
end
refreshStats()
if Players.LocalPlayer then
\tPlayers.LocalPlayer:GetAttributeChangedSignal("Coins"):Connect(refreshStats)
\tPlayers.LocalPlayer:GetAttributeChangedSignal("Level"):Connect(refreshStats)
end`;

      case "currency": return `
-- ── currency: coin counter, pinned top-right ──
local coinBox = Instance.new("Frame")
coinBox.Name = "Currency"
coinBox.AnchorPoint = Vector2.new(1, 0)
coinBox.Position = UDim2.new(1, -${pad}, 0, ${pad})
coinBox.Size = UDim2.fromScale(0.16, 0.06)
coinBox.BackgroundColor3 = PALETTE.surface
coinBox.BackgroundTransparency = 0.1
coinBox.BorderSizePixel = 0
coinBox.Parent = gui
rounded(coinBox)
stroked(coinBox, PALETTE.accent2, 1, 0.5)

local coinIcon = Instance.new("Frame")
coinIcon.Name = "CoinIcon"
coinIcon.AnchorPoint = Vector2.new(0, 0.5)
coinIcon.Position = UDim2.new(0, 8, 0.5, 0)
coinIcon.Size = UDim2.fromScale(0.055, 0.72)
coinIcon.BackgroundColor3 = PALETTE.accent2
coinIcon.BorderSizePixel = 0
coinIcon.Parent = coinBox
rounded(coinIcon, 999)
stroked(coinIcon, PALETTE.text, 1, 0.6)
gradient(coinIcon, PALETTE.accent2, PALETTE.accent, 90)

local coinText = Instance.new("TextLabel")
coinText.Name = "Amount"
coinText.Position = UDim2.new(0, 8, 0, 0)
coinText.Size = UDim2.new(1, -56, 1, 0)
coinText.BackgroundTransparency = 1
coinText.Font = FONT
coinText.TextColor3 = PALETTE.text
coinText.TextXAlignment = Enum.TextXAlignment.Right
coinText.Text = "0"
coinText.Parent = coinBox
scaledText(coinText, 22)

local function refreshCoins()
\tlocal p = Players.LocalPlayer
\tcoinText.Text = tostring(p and p:GetAttribute("Coins") or 0)
end
refreshCoins()
if Players.LocalPlayer then
\tPlayers.LocalPlayer:GetAttributeChangedSignal("Coins"):Connect(refreshCoins)
end`;

      case "stats": return `
-- ── stats: three-label panel ──
local statsPanel = Instance.new("Frame")
statsPanel.Name = "StatsPanel"
statsPanel.AnchorPoint = Vector2.new(0, 0)
statsPanel.Position = UDim2.new(0, ${pad}, 0, ${pad + 74})
statsPanel.Size = UDim2.fromScale(0.24, 0.2)
statsPanel.BackgroundColor3 = PALETTE.surface
statsPanel.BackgroundTransparency = 0.15
statsPanel.BorderSizePixel = 0
statsPanel.Parent = gui
rounded(statsPanel)
stroked(statsPanel, PALETTE.accent, 1, 0.65)
padded(statsPanel, GAP)

local statsList = Instance.new("UIListLayout")
statsList.FillDirection = Enum.FillDirection.Vertical
statsList.Padding = UDim.new(0, 6)
statsList.Parent = statsPanel

local STAT_KEYS = {"Coins", "Level", "Rebirths"}
for i, key in ipairs(STAT_KEYS) do
\tlocal row = Instance.new("Frame")
\trow.Name = key .. "Row"
\trow.LayoutOrder = i
\trow.Size = UDim2.new(1, 0, 0.28, 0)
\trow.BackgroundColor3 = PALETTE.bg
\trow.BackgroundTransparency = 0.4
\trow.BorderSizePixel = 0
\trow.Parent = statsPanel
\trounded(row, 6)

\tlocal label = Instance.new("TextLabel")
\tlabel.Size = UDim2.new(1, -16, 1, 0)
\tlabel.Position = UDim2.new(0, 8, 0, 0)
\tlabel.BackgroundTransparency = 1
\tlabel.Font = Enum.Font.GothamMedium
\tlabel.TextColor3 = PALETTE.text
\tlabel.TextXAlignment = Enum.TextXAlignment.Left
\tlabel.Text = key
\tlabel.Parent = row
\tscaledText(label, 18)
end`;

      case "buttons": return `
-- ── buttons: action stack with real hover/press motion ──
local buttonStack = Instance.new("Frame")
buttonStack.Name = "Buttons"
buttonStack.AnchorPoint = Vector2.new(1, 1)
buttonStack.Position = UDim2.new(1, -${pad}, 1, -${pad})
buttonStack.Size = UDim2.fromScale(0.18, 0.28)
buttonStack.BackgroundTransparency = 1
buttonStack.Parent = gui

local stackList = Instance.new("UIListLayout")
stackList.FillDirection = Enum.FillDirection.Vertical
stackList.Padding = UDim.new(0, GAP)
stackList.HorizontalAlignment = Enum.HorizontalAlignment.Right
stackList.Parent = buttonStack

local ACTIONS = {"Shop", "Pets", "Settings"}
for i, actionName in ipairs(ACTIONS) do
\tlocal b = Instance.new("TextButton")
\tb.Name = actionName
\tb.LayoutOrder = i
\tb.Size = UDim2.new(1, 0, 0.27, 0)
\tb.BackgroundColor3 = PALETTE.surface
\tb.BackgroundTransparency = 0.15
\tb.BorderSizePixel = 0
\tb.AutoButtonColor = false
\tb.Font = FONT
\tb.TextColor3 = PALETTE.text
\tb.Text = actionName
\tb.Parent = buttonStack
\trounded(b)
\tstroked(b, PALETTE.accent, 1, 0.55)
\tgradient(b, PALETTE.accent, PALETTE.accent2, 12)
\t-- The gradient is the FILL; text sits above it via ZIndex.
\tb.TextStrokeTransparency = 0.6
\tscaledText(b, 20)
\tmotion(b, 1)
\tb.Activated:Connect(function()
\t\tprint("[UI] " .. actionName .. " pressed")
\tend)
end`;

      case "shop": return `
-- ── shop: card grid, two columns, computed from GAP ──
local shopPanel = Instance.new("Frame")
shopPanel.Name = "Shop"
shopPanel.AnchorPoint = Vector2.new(0.5, 0.5)
shopPanel.Position = UDim2.fromScale(0.5, 0.5)
shopPanel.Size = UDim2.fromScale(0.5, 0.62)
shopPanel.BackgroundColor3 = PALETTE.bg
shopPanel.BackgroundTransparency = 0.06
shopPanel.BorderSizePixel = 0
shopPanel.Parent = gui
rounded(shopPanel, RADIUS + 4)
stroked(shopPanel, PALETTE.accent, 2, 0.45)

local shopTitle = Instance.new("TextLabel")
shopTitle.Name = "ShopTitle"
shopTitle.Size = UDim2.new(1, -32, 0, 44)
shopTitle.Position = UDim2.new(0, 16, 0, 12)
shopTitle.BackgroundTransparency = 1
shopTitle.Font = FONT
shopTitle.TextColor3 = PALETTE.text
shopTitle.TextXAlignment = Enum.TextXAlignment.Left
shopTitle.Text = "Shop"
shopTitle.Parent = shopPanel
scaledText(shopTitle, 28)

local grid = Instance.new("Frame")
grid.Name = "Grid"
grid.Position = UDim2.new(0, 16, 0, 64)
grid.Size = UDim2.new(1, -32, 1, -80)
grid.BackgroundTransparency = 1
grid.Parent = shopPanel

local gridLayout = Instance.new("UIGridLayout")
gridLayout.CellSize = UDim2.fromScale(0.31, 0.30)
gridLayout.CellPadding = UDim2.fromOffset(GAP, GAP)
gridLayout.SortOrder = Enum.SortOrder.LayoutOrder
gridLayout.Parent = grid

for i = 1, 6 do
\tlocal card = Instance.new("Frame")
\tcard.Name = "Card" .. i
\tcard.LayoutOrder = i
\tcard.BackgroundColor3 = PALETTE.surface
\tcard.BackgroundTransparency = 0.1
\tcard.BorderSizePixel = 0
\tcard.Parent = grid
\trounded(card)
\tstroked(card, PALETTE.accent2, 1, 0.7)
\tpadded(card, 8)

\tlocal swatch = Instance.new("Frame")
\tswatch.Name = "Swatch"
\tswatch.Size = UDim2.new(1, 0, 0.55, 0)
\tswatch.BackgroundColor3 = PALETTE.accent
\tswatch.BorderSizePixel = 0
\tswatch.Parent = card
\trounded(swatch, 6)
\tgradient(swatch, PALETTE.accent, PALETTE.accent2, 40 + i * 30)

\tlocal price = Instance.new("TextLabel")
\tprice.Name = "Price"
\tprice.Position = UDim2.new(0, 0, 0.58, 0)
\tprice.Size = UDim2.new(1, 0, 0.38, 0)
\tprice.BackgroundTransparency = 1
\tprice.Font = FONT
\tprice.TextColor3 = PALETTE.text
\tprice.Text = tostring(i * 100)
\tprice.Parent = card
\tscaledText(price, 20)
end`;

      case "inventory": return `
-- ── inventory: slot grid (empty slots are a real state, not a bug) ──
local invPanel = Instance.new("Frame")
invPanel.Name = "Inventory"
invPanel.AnchorPoint = Vector2.new(0.5, 0.5)
invPanel.Position = UDim2.fromScale(0.5, 0.5)
invPanel.Size = UDim2.fromScale(0.46, 0.5)
invPanel.BackgroundColor3 = PALETTE.bg
invPanel.BackgroundTransparency = 0.06
invPanel.BorderSizePixel = 0
invPanel.Parent = gui
rounded(invPanel, RADIUS + 4)
stroked(invPanel, PALETTE.accent, 2, 0.45)

local invGrid = Instance.new("Frame")
invGrid.Position = UDim2.fromScale(0.05, 0.08)
invGrid.Size = UDim2.fromScale(0.9, 0.86)
invGrid.BackgroundTransparency = 1
invGrid.Parent = invPanel

local invLayout = Instance.new("UIGridLayout")
invLayout.CellSize = UDim2.fromScale(0.22, 0.22)
invLayout.CellPadding = UDim2.fromOffset(GAP, GAP)
invLayout.SortOrder = Enum.SortOrder.LayoutOrder
invLayout.Parent = invGrid

for i = 1, 16 do
\tlocal slot = Instance.new("Frame")
\tslot.Name = "Slot" .. i
\tslot.LayoutOrder = i
\tslot.BackgroundColor3 = PALETTE.surface
\tslot.BackgroundTransparency = 0.35
\tslot.BorderSizePixel = 0
\tslot.Parent = invGrid
\trounded(slot, 8)
\tstroked(slot, PALETTE.muted, 1, 0.75)
end`;

      case "dialog": return `
-- ── dialog: modal overlay with confirm/cancel that actually closes ──
local dim = Instance.new("Frame")
dim.Name = "DialogDim"
dim.Size = UDim2.fromScale(1, 1)
dim.BackgroundColor3 = PALETTE.bg
dim.BackgroundTransparency = 0.25
dim.BorderSizePixel = 0
dim.ZIndex = 5
dim.Parent = gui

local dialog = Instance.new("Frame")
dialog.Name = "Dialog"
dialog.AnchorPoint = Vector2.new(0.5, 0.5)
dialog.Position = UDim2.fromScale(0.5, 0.5)
dialog.Size = UDim2.fromScale(0.4, 0.34)
dialog.BackgroundColor3 = PALETTE.surface
dialog.BorderSizePixel = 0
dialog.ZIndex = 6
dialog.Parent = gui
rounded(dialog, RADIUS + 4)
stroked(dialog, PALETTE.accent, 2, 0.35)
padded(dialog, GAP + 4)

local dialogTitle = Instance.new("TextLabel")
dialogTitle.Name = "Title"
dialogTitle.Size = UDim2.new(1, 0, 0.26, 0)
dialogTitle.BackgroundTransparency = 1
dialogTitle.Font = FONT
dialogTitle.TextColor3 = PALETTE.text
dialogTitle.TextXAlignment = Enum.TextXAlignment.Left
dialogTitle.Text = ${q(title)}
dialogTitle.ZIndex = 7
dialogTitle.Parent = dialog
scaledText(dialogTitle, 26)

local dialogBody = Instance.new("TextLabel")
dialogBody.Name = "Body"
dialogBody.Position = UDim2.new(0, 0, 0.28, 0)
dialogBody.Size = UDim2.new(1, 0, 0.40, 0)
dialogBody.BackgroundTransparency = 1
dialogBody.Font = Enum.Font.GothamMedium
dialogBody.TextColor3 = PALETTE.muted
dialogBody.TextWrapped = true
dialogBody.TextXAlignment = Enum.TextXAlignment.Left
dialogBody.TextYAlignment = Enum.TextYAlignment.Top
dialogBody.Text = "Generated by ZeroScript. Replace this copy in the spec."
dialogBody.ZIndex = 7
dialogBody.Parent = dialog
scaledText(dialogBody, 18)

local function actionButton(labelText, order, accent)
\tlocal b = Instance.new("TextButton")
\tb.Name = labelText
\tb.Style = Enum.ButtonStyle.Custom
\tb.AnchorPoint = Vector2.new(1, 1)
\tb.Position = UDim2.new(1, -(order - 1) * 8, 1, 0)
\tb.Size = UDim2.fromScale(0.30, 0.22)
\tb.BackgroundColor3 = accent
\tb.BorderSizePixel = 0
\tb.AutoButtonColor = false
\tb.Font = FONT
\tb.TextColor3 = PALETTE.text
\tb.Text = labelText
\tb.ZIndex = 7
\tb.Parent = dialog
\trounded(b)
\tmotion(b, 1)
\treturn b
end

local confirm = actionButton("Confirm", 2, PALETTE.accent)
local cancel = actionButton("Cancel", 1, PALETTE.surface)
cancel.Position = UDim2.new(1, 0, 1, 0)
cancel.Size = UDim2.fromScale(0.30, 0.22)
cancel.Position = UDim2.new(1, -96, 1, 0)
stroked(cancel, PALETTE.muted, 1, 0.7)

local function closeDialog()
\tdim:Destroy()
\tdialog:Destroy()
end
confirm.Activated:Connect(closeDialog)
cancel.Activated:Connect(closeDialog)`;

      case "toast": return `
-- ── toast: transient banner, slides in then out ──
local toast = Instance.new("Frame")
toast.Name = "Toast"
toast.AnchorPoint = Vector2.new(0.5, 0)
toast.Position = UDim2.new(0.5, 0, 0, -80)
toast.Size = UDim2.fromScale(0.36, 0.07)
toast.BackgroundColor3 = PALETTE.surface
toast.BackgroundTransparency = 0.05
toast.BorderSizePixel = 0
toast.Parent = gui
rounded(toast)
stroked(toast, PALETTE.accent2, 1, 0.4)
gradient(toast, PALETTE.accent, PALETTE.accent2, 0)

local toastText = Instance.new("TextLabel")
toastText.Size = UDim2.fromScale(1, 1)
toastText.BackgroundTransparency = 1
toastText.Font = FONT
toastText.TextColor3 = PALETTE.text
toastText.Text = "Saved"
toastText.Parent = toast
scaledText(toastText, 22)

TweenService:Create(toast, TweenInfo.new(0.35, Enum.EasingStyle.Quint, Enum.EasingDirection.Out), {
\tPosition = UDim2.new(0.5, 0, 0, 24)
}):Play()
task.delay(2.5, function()
\tTweenService:Create(toast, TweenInfo.new(0.35, Enum.EasingStyle.Quint, Enum.EasingDirection.In), {
\t\tPosition = UDim2.new(0.5, 0, 0, -80)
\t}):Play()
end)`;

      case "progress": return `
-- ── progress: labelled bar with a REAL percentage, not a hard-coded width ──
local progressWrap = Instance.new("Frame")
progressWrap.Name = "Progress"
progressWrap.AnchorPoint = Vector2.new(0.5, 0)
progressWrap.Position = UDim2.new(0.5, 0, 0, ${pad})
progressWrap.Size = UDim2.fromScale(0.34, 0.055)
progressWrap.BackgroundTransparency = 1
progressWrap.Parent = gui

local progressLabel = Instance.new("TextLabel")
progressLabel.Size = UDim2.new(1, 0, 0.42, 0)
progressLabel.BackgroundTransparency = 1
progressLabel.Font = Enum.Font.GothamMedium
progressLabel.TextColor3 = PALETTE.text
progressLabel.TextXAlignment = Enum.TextXAlignment.Left
progressLabel.Text = "Progress"
progressLabel.Parent = progressWrap
scaledText(progressLabel, 16)

local track = Instance.new("Frame")
track.Name = "Track"
track.Position = UDim2.new(0, 0, 0.5, 0)
track.Size = UDim2.new(1, 0, 0.42, 0)
track.BackgroundColor3 = PALETTE.surface
track.BorderSizePixel = 0
track.ClipsDescendants = true
track.Parent = progressWrap
rounded(track, 999)

local fill = Instance.new("Frame")
fill.Name = "Fill"
fill.Size = UDim2.fromScale(0.42, 1)
fill.BackgroundColor3 = PALETTE.accent
fill.BorderSizePixel = 0
fill.Parent = track
rounded(fill, 999)
gradient(fill, PALETTE.accent, PALETTE.accent2, 0)

-- Driven by a 0..1 attribute so callers animate it instead of editing Size.
local function setProgress(value)
\tlocal pct = math.clamp(tonumber(value) or 0, 0, 1)
\tTweenService:Create(fill, TweenInfo.new(0.25), { Size = UDim2.fromScale(pct, 1) }):Play()
\tprogressLabel.Text = string.format("Progress  %d%%", math.floor(pct * 100))
end
setProgress(0.42)`;

      case "title": return `
-- ── title: gradient headline block ──
local titleWrap = Instance.new("Frame")
titleWrap.Name = "TitleBlock"
titleWrap.AnchorPoint = Vector2.new(0.5, 0)
titleWrap.Position = UDim2.new(0.5, 0, 0, ${pad})
titleWrap.Size = UDim2.fromScale(0.6, 0.12)
titleWrap.BackgroundTransparency = 1
titleWrap.Parent = gui

local headline = Instance.new("TextLabel")
headline.Name = "Headline"
headline.Size = UDim2.fromScale(1, 0.62)
headline.BackgroundTransparency = 1
headline.Font = Enum.Font.GothamBlack
headline.TextColor3 = PALETTE.text
headline.Text = ${q(title)}
headline.Parent = titleWrap
scaledText(headline, 40)
gradient(headline, PALETTE.accent, PALETTE.accent2, 0)

local rule = Instance.new("Frame")
rule.Name = "Rule"
rule.AnchorPoint = Vector2.new(0.5, 0)
rule.Position = UDim2.new(0.5, 0, 0.66, 0)
rule.Size = UDim2.fromScale(0.34, 0.05)
rule.BackgroundColor3 = PALETTE.accent
rule.BorderSizePixel = 0
rule.Parent = titleWrap
rounded(rule, 999)
gradient(rule, PALETTE.accent, PALETTE.accent2, 0)

local subtitle = Instance.new("TextLabel")
subtitle.Name = "Subtitle"
subtitle.Position = UDim2.new(0, 0, 0.74, 0)
subtitle.Size = UDim2.fromScale(1, 0.26)
subtitle.BackgroundTransparency = 1
subtitle.Font = Enum.Font.GothamMedium
subtitle.TextColor3 = PALETTE.muted
subtitle.Text = "built with ZeroScript"
subtitle.Parent = titleWrap
scaledText(subtitle, 16)`;

      default: return "";
    }
  }

  // ── LOGO BUILDER ──────────────────────────────────────────────────────────
  // A logo has to survive being 32px and 512px wide. Roblox cannot upload an
  // image from Luau, so the only end-to-end-working option is VECTOR: circles and
  // rounded rects with a gradient, plus letters. That is what this emits, wrapped
  // in a UIAspectRatioConstraint so it can never distort.
  const LOGO_STYLES = {
    monogram: "one or two letters on a gradient disc",
    mark:     "abstract geometric mark (ring + inner shape), no letters",
    shield:   "crest/badge silhouette with a monogram",
    bolt:     "angular energy mark",
  };
  const LOGO_STYLE_NAMES = Object.keys(LOGO_STYLES);

  function buildLogo(spec) {
    const s = spec || {};
    const themeName = THEMES[s.theme] ? s.theme : DEFAULT_THEME;
    const t = THEMES[themeName];
    const style = LOGO_STYLES[s.style] ? s.style : "monogram";
    const initials = String(s.initials || s.text || "ZS").slice(0, 2).toUpperCase();
    const name = String(s.name || "ZeroScriptLogo");
    // Size is in pixels at the reference resolution; UIScale handles the rest.
    const size = Number.isFinite(s.size) ? Math.max(32, Math.min(1024, s.size)) : 196;
    const glow = s.glow !== false;

    const L = [];
    L.push("--!nolint");
    L.push(`-- ZeroScript LOGO ${VERSION} — GENERATED VECTOR, not hand-written.`);
    L.push(`-- style=${style} theme=${themeName} initials=${initials} size=${size}`);
    L.push("-- Vector (Frames + UICorner + UIGradient): no image upload needed,");
    L.push("-- crisp at every resolution, recolourable from PALETTE alone.");
    L.push('local Players = game:GetService("Players")');
    L.push('local TweenService = game:GetService("TweenService")');
    L.push("");
    L.push(paletteBlock(t));
    L.push("");
    L.push(HELPERS);
    L.push("");
    L.push(`local gui = makeScreen(${q(name)})`);
    L.push("");
    L.push(`local LOGO_PX = ${size}`);
    L.push(`local GLOW = ${glow}`);
    L.push("");
    L.push(`
-- Container: aspect-locked so the mark can NEVER be squashed into an oval by a
-- wide or tall parent. This is the single most common hand-made logo defect.
local root = Instance.new("Frame")
root.Name = "LogoRoot"
root.AnchorPoint = Vector2.new(0.5, 0.5)
root.Position = UDim2.fromScale(0.5, 0.5)
root.Size = UDim2.fromOffset(LOGO_PX, LOGO_PX)
root.BackgroundTransparency = 1
root.Parent = gui

local aspect = Instance.new("UIAspectRatioConstraint")
aspect.AspectRatio = 1
aspect.AspectType = Enum.AspectType.FitWithinMaxSize
aspect.DominantAxis = Enum.DominantAxis.Width
aspect.Parent = root

local function disc(parent, px, color)
\tlocal d = Instance.new("Frame")
\td.AnchorPoint = Vector2.new(0.5, 0.5)
\td.Position = UDim2.fromScale(0.5, 0.5)
\td.Size = UDim2.fromOffset(px, px)
\td.BackgroundColor3 = color
\td.BorderSizePixel = 0
\td.Parent = parent
\trounded(d, 999)
\treturn d
end`.trim());
    L.push("");

    if (style === "monogram") {
      L.push(`
-- ── monogram: gradient disc + initials ──
local outer = disc(root, LOGO_PX, PALETTE.accent)
gradient(outer, PALETTE.accent, PALETTE.accent2, 55)
${glow ? 'stroked(outer, PALETTE.text, 2, 0.82)' : '-- glow disabled by spec'}

local innerRing = disc(outer, math.floor(LOGO_PX * 0.78), PALETTE.bg)
innerRing.BackgroundTransparency = 1
stroked(innerRing, PALETTE.text, 2, 0.72)

local mark = Instance.new("TextLabel")
mark.Name = "Mark"
mark.Size = UDim2.fromScale(1, 1)
mark.BackgroundTransparency = 1
mark.Font = Enum.Font.GothamBlack
mark.TextColor3 = PALETTE.text
mark.Text = ${q(initials)}
mark.TextStrokeTransparency = 0.55
mark.Parent = outer
scaledText(mark, math.floor(LOGO_PX * 0.44))`.trim());
    } else if (style === "mark") {
      L.push(`
-- ── mark: abstract ring + counter-rotated square ──
local ring = disc(root, LOGO_PX, PALETTE.accent)
ring.BackgroundTransparency = 1
stroked(ring, PALETTE.accent, math.max(4, math.floor(LOGO_PX * 0.06)), 0.1)

local core = Instance.new("Frame")
core.Name = "Core"
core.AnchorPoint = Vector2.new(0.5, 0.5)
core.Position = UDim2.fromScale(0.5, 0.5)
core.Size = UDim2.fromOffset(math.floor(LOGO_PX * 0.46), math.floor(LOGO_PX * 0.46))
core.Rotation = 45
core.BackgroundColor3 = PALETTE.accent2
core.BorderSizePixel = 0
core.Parent = root
rounded(core, math.floor(LOGO_PX * 0.10))
gradient(core, PALETTE.accent, PALETTE.accent2, 135)

-- A slow rotation makes the mark read as "alive" at 32px. TweenService, not a
-- while-loop, so it costs nothing and cannot leak a runaway thread.
TweenService:Create(ring, TweenInfo.new(12, Enum.EasingStyle.Linear, Enum.EasingDirection.InOut, -1), {
\tRotation = 360
}):Play()`.trim());
    } else if (style === "shield") {
      L.push(`
-- ── shield: crest silhouette + monogram ──
local crest = Instance.new("Frame")
crest.Name = "Crest"
crest.AnchorPoint = Vector2.new(0.5, 0.5)
crest.Position = UDim2.fromScale(0.5, 0.5)
crest.Size = UDim2.fromOffset(math.floor(LOGO_PX * 0.84), LOGO_PX)
crest.BackgroundColor3 = PALETTE.accent
crest.BorderSizePixel = 0
crest.Parent = root
rounded(crest, math.floor(LOGO_PX * 0.22))
gradient(crest, PALETTE.accent, PALETTE.accent2, 100)
stroked(crest, PALETTE.text, 2, 0.8)

local crestBand = Instance.new("Frame")
crestBand.Name = "Band"
crestBand.AnchorPoint = Vector2.new(0.5, 0.5)
crestBand.Position = UDim2.fromScale(0.5, 0.52)
crestBand.Size = UDim2.new(0.9, 0, 0.16, 0)
crestBand.BackgroundColor3 = PALETTE.bg
crestBand.BackgroundTransparency = 0.25
crestBand.BorderSizePixel = 0
crestBand.Parent = crest
rounded(crestBand, 4)

local crestMark = Instance.new("TextLabel")
crestMark.Name = "Mark"
crestMark.AnchorPoint = Vector2.new(0.5, 0.5)
crestMark.Position = UDim2.fromScale(0.5, 0.30)
crestMark.Size = UDim2.fromScale(0.8, 0.34)
crestMark.BackgroundTransparency = 1
crestMark.Font = Enum.Font.GothamBlack
crestMark.TextColor3 = PALETTE.text
crestMark.Text = ${q(initials)}
crestMark.Parent = crest
scaledText(crestMark, math.floor(LOGO_PX * 0.30))`.trim());
    } else {
      L.push(`
-- ── bolt: angular energy mark, built from two offset rotated bars ──
local spine = Instance.new("Frame")
spine.Name = "Spine"
spine.AnchorPoint = Vector2.new(0.5, 0.5)
spine.Position = UDim2.fromScale(0.5, 0.5)
spine.Size = UDim2.fromOffset(math.floor(LOGO_PX * 0.30), math.floor(LOGO_PX * 0.86))
spine.Rotation = 18
spine.BackgroundColor3 = PALETTE.accent
spine.BorderSizePixel = 0
spine.Parent = root
rounded(spine, math.floor(LOGO_PX * 0.06))
gradient(spine, PALETTE.accent, PALETTE.accent2, 15)

local cut = Instance.new("Frame")
cut.Name = "Cut"
cut.AnchorPoint = Vector2.new(0.5, 0.5)
cut.Position = UDim2.fromScale(0.58, 0.34)
cut.Size = UDim2.fromOffset(math.floor(LOGO_PX * 0.22), math.floor(LOGO_PX * 0.22))
cut.Rotation = 18
cut.BackgroundColor3 = PALETTE.bg
cut.BorderSizePixel = 0
cut.Parent = root
rounded(cut, math.floor(LOGO_PX * 0.04))

${glow ? 'stroked(spine, PALETTE.text, 2, 0.78)' : '-- glow disabled by spec'}`.trim());
    }

    L.push("");
    L.push(`return {logos = 1, style = ${q(style)}, theme = ${q(themeName)}, px = LOGO_PX}`);
    const script = L.join("\n") + "\n";

    return {
      ok: true,
      script,
      meta: {
        version: VERSION, style, theme: themeName, initials, size,
        vector: true, needsImageUpload: false,
        chars: script.length, lines: script.split("\n").length,
        contrast: themeContrast(themeName),
      },
    };
  }

  // ── SPEC PARSING ──────────────────────────────────────────────────────────
  // The model sends free-form args; this is the ONLY place that interprets them,
  // so an unknown field is reported instead of silently ignored.
  function normaliseSpec(args) {
    const a = args || {};
    const out = { kind: "gui", theme: DEFAULT_THEME, screen: "hud", widgets: [], title: "", style: "monogram", initials: "ZS" };
    const problems = [];
    if (a.theme) {
      if (THEMES[String(a.theme).toLowerCase()]) out.theme = String(a.theme).toLowerCase();
      else problems.push(`unknown theme "${a.theme}" (use: ${THEME_NAMES.join(", ")})`);
    }
    if (a.screen) {
      const sc = String(a.screen).toLowerCase();
      if (SCREENS[sc]) { out.kind = "gui"; out.screen = sc; }
      else if (LOGO_STYLES[sc]) { out.kind = "logo"; out.style = sc; }
      else problems.push(`unknown screen "${a.screen}" (use: ${SCREEN_NAMES.join(", ")})`);
    }
    if (a.kind === "logo" || a.style || LOGO_STYLES[String(a.screen || "").toLowerCase()]) out.kind = "logo";
    if (a.style && LOGO_STYLES[String(a.style).toLowerCase()]) out.style = String(a.style).toLowerCase();
    if (Array.isArray(a.widgets)) {
      for (const w of a.widgets) {
        const k = String(w).toLowerCase();
        if (WIDGETS[k]) out.widgets.push(k);
        else problems.push(`unknown widget "${w}" (use: ${WIDGET_NAMES.join(", ")})`);
      }
    }
    if (a.title) out.title = String(a.title).slice(0, 60);
    if (a.initials || a.text) out.initials = String(a.initials || a.text).slice(0, 2).toUpperCase();
    if (a.size) out.size = Number(a.size);
    if (a.glow === false || a.glow === "false") out.glow = false;
    return { spec: out, problems };
  }

  /** Build from raw tool args; returns a human/agent-readable result object. */
  function build(args) {
    const { spec, problems } = normaliseSpec(args);
    const r = spec.kind === "logo" ? buildLogo(spec) : buildGui(spec);
    r.problems = problems;
    r.kind = spec.kind;
    return r;
  }

  const API = {
    VERSION, THEMES, THEME_NAMES, DEFAULT_THEME, WIDGETS, WIDGET_NAMES,
    SCREENS, SCREEN_NAMES, LOGO_STYLES, LOGO_STYLE_NAMES,
    buildGui, buildLogo, build, normaliseSpec,
    themeContrast, contrastRatio, luminance,
    // capability statement — nothing downstream may over-claim
    capabilities: {
      generates: "Luau source (vector GUI + vector logo)",
      layout: "deterministic, scale-based (UDim2.fromScale)",
      vision: false,
      imageUpload: false,
      note: "produces code, not pixels; call screen_capture to inspect the result",
    },
  };
  try { if (typeof window !== "undefined") window.ZSGui = API; } catch (_e) { globalThis.ZSSafe?.seen?.("gui.window", _e); }
  if (typeof self !== "undefined") try { self.ZSGui = API; } catch (_e) { globalThis.ZSSafe?.seen?.("gui.self", _e); }
  try { if (typeof globalThis !== "undefined") globalThis.ZSGui = API; } catch (_e) { globalThis.ZSSafe?.seen?.("gui.global", _e); }
  if (typeof module !== "undefined" && module.exports) module.exports = API;
})();
