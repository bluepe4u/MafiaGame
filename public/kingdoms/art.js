'use strict';

// Citadels pictures, drawn as small line-art SVGs (no image files): a building for every district
// and an emblem for every character. Colours come from CSS: .b body, .r roof/accent, .w lit window
// or gold, .s plain line, .wa water, .gnd the ground, .bg the skyline behind. Districts use a 100×64 frame, characters 64×64.

const CIT_ART = (() => {
  const gnd = '<path class="gnd" d="M2 58H98"/>';
  const door = (x, w = 8, h = 11) => `<path class="b" d="M${x} 58v-${h - w / 2}a${w / 2} ${w / 2} 0 0 1 ${w} 0V58z"/>`;
  const win = (x, y, w = 6, h = 7) => `<rect class="w" x="${x}" y="${y}" width="${w}" height="${h}" rx="1"/>`;
  const arch = (x, y, w = 5, h = 8) => `<path class="w" d="M${x} ${y + h}v-${h - w / 2}a${w / 2} ${w / 2} 0 0 1 ${w} 0v${h - w / 2}z"/>`;
  const crenel = (x1, x2, y, n) => {
    const step = (x2 - x1) / (n * 2 - 1);
    let d = '';
    for (let i = 0; i < n; i++) d += `<rect class="b" x="${x1 + i * 2 * step}" y="${y - 4}" width="${step}" height="4.5"/>`;
    return d;
  };
  const waves = '<path class="wa" d="M2 60q4-3 8 0t8 0 8 0 8 0 8 0 8 0 8 0 8 0 8 0 8 0 8 0 8 0"/>';
  const flag = (x, y) => `<path class="s" d="M${x} ${y}v-12"/><path class="r" d="M${x} ${y - 12}h9l-3 3 3 3h-9z"/>`;

  const D = {
    manor: `<rect class="b" x="28" y="34" width="44" height="24"/><rect class="b" x="61" y="20" width="6" height="12"/><path class="r" d="M23 35L50 17l27 18z"/>${win(33, 40)}${win(61, 40)}${door(46)}`,
    castle: `${crenel(16, 36, 22, 3)}${crenel(64, 84, 22, 3)}<rect class="b" x="17" y="22" width="18" height="36"/><rect class="b" x="65" y="22" width="18" height="36"/><rect class="b" x="35" y="34" width="30" height="24"/>${crenel(35, 65, 34, 4)}<path class="r" d="M43 58V49a7 7 0 0 1 14 0v9z"/>${arch(23.5, 30)}${arch(71.5, 30)}${flag(74, 18)}`,
    palace: `<rect class="b" x="14" y="36" width="72" height="22"/><path class="r" d="M36 36a14 14 0 0 1 28 0z"/><path class="s" d="M50 22v-7"/><circle class="w" cx="50" cy="14" r="1.8"/><path class="s" d="M22 40v16M30 40v16M38 40v16M62 40v16M70 40v16M78 40v16"/><rect class="b" x="12" y="55" width="76" height="3"/>${door(46, 8, 12)}`,
    temple: `<rect class="b" x="20" y="52" width="60" height="6"/><rect class="b" x="24" y="34" width="52" height="4"/><path class="r" d="M20 34L50 18l30 16z"/><path class="s" d="M29 38v14M38 38v14M47 38v14M53 38v14M62 38v14M71 38v14"/><circle class="w" cx="50" cy="28" r="2.2"/>`,
    church: `<rect class="b" x="20" y="36" width="42" height="22"/><path class="r" d="M17 37l21-13 21 13z"/><rect class="b" x="62" y="24" width="14" height="34"/><path class="r" d="M60 25l9-17 9 17z"/><path class="s" d="M69 2v7M66 4.5h6"/><circle class="w" cx="40" cy="44" r="3.5"/>${arch(66.5, 32)}${door(25)}`,
    monastery: `<rect class="b" x="12" y="40" width="58" height="18"/><path class="r" d="M10 41l10-9h42l10 9z"/><rect class="b" x="70" y="22" width="14" height="36"/><path class="r" d="M68 23l9-12 9 12z"/><circle class="w" cx="77" cy="30" r="2.5"/>${arch(18, 45)}${arch(28, 45)}${arch(38, 45)}${arch(48, 45)}${arch(58, 45)}`,
    cathedral: `<rect class="b" x="32" y="30" width="36" height="28"/><path class="r" d="M30 31l20-14 20 14z"/><rect class="b" x="20" y="20" width="12" height="38"/><rect class="b" x="68" y="20" width="12" height="38"/><path class="r" d="M18 21l8-16 8 16zM66 21l8-16 8 16z"/><circle class="w" cx="50" cy="38" r="5"/><path class="s" d="M50 33v10M45 38h10"/>${arch(23.5, 28)}${arch(71.5, 28)}${door(45, 10, 13)}`,
    tavern: `<rect class="b" x="24" y="32" width="40" height="26"/><path class="r" d="M19 33l25-16 25 16z"/><path class="s" d="M64 36h16M77 36v3"/><rect class="r" x="71" y="39" width="12" height="9" rx="1.5"/><path class="s" d="M74 42h4v4h-4zM78 43h1.5v2H78"/>${win(29, 38, 8, 7)}${win(51, 38, 8, 7)}${door(40)}`,
    market: `<path class="s" d="M14 34v24M44 34v24M56 34v24M86 34v24"/><path class="r" d="M10 35h38l-4-9H14z"/><path class="r" d="M52 35h38l-4-9H56z"/><path class="s" d="M20 26l-2 9M26 26v9M32 26v9M38 26l2 9M62 26l-2 9M68 26v9M74 26v9M80 26l2 9"/><rect class="b" x="14" y="46" width="30" height="4"/><rect class="b" x="56" y="46" width="30" height="4"/><circle class="w" cx="22" cy="44" r="2"/><circle class="w" cx="28" cy="44" r="2"/><circle class="w" cx="66" cy="44" r="2"/><rect class="w" x="74" y="42" width="5" height="4"/>`,
    tradingPost: `<rect class="b" x="16" y="30" width="52" height="28"/><path class="r" d="M13 31l29-14 29 14z"/><rect class="r" x="32" y="40" width="20" height="18"/><path class="s" d="M32 40l20 18M52 40L32 58"/><rect class="b" x="72" y="48" width="10" height="10"/><rect class="b" x="84" y="48" width="10" height="10"/><rect class="b" x="78" y="38" width="10" height="10"/><path class="s" d="M72 48l10 10M84 48l10 10M78 38l10 10"/>`,
    docks: `${waves}<rect class="b" x="6" y="49" width="58" height="4"/><path class="s" d="M12 53v6M28 53v6M44 53v6M60 53v6"/><path class="s" d="M74 53V12M74 14h22M74 22l10-8M92 14v14"/><rect class="r" x="88" y="28" width="8" height="7"/><rect class="b" x="70" y="49" width="10" height="4"/><rect class="b" x="18" y="41" width="8" height="8"/><rect class="b" x="30" y="43" width="12" height="6"/>`,
    harbor: `${waves}<path class="b" d="M14 50h40l-6 8H20z"/><path class="s" d="M34 50V14"/><path class="r" d="M36 16v30l18-3z"/><path class="r" d="M32 20v24l-12-2z"/><path class="b" d="M72 58l3-34h8l3 34z"/><rect class="r" x="73" y="18" width="12" height="6"/><path class="w" d="M76 18l3-4 3 4z"/><path class="s" d="M88 16l8-3M88 21h8M70 16l-8-3"/>`,
    townHall: `<rect class="b" x="16" y="36" width="68" height="22"/><path class="r" d="M14 37l10-6h52l10 6z"/><rect class="b" x="42" y="14" width="16" height="44"/><path class="r" d="M40 15l10-11 10 11z"/><circle class="w" cx="50" cy="24" r="5"/><path class="s" d="M50 21v3l2 1.5"/>${win(22, 42)}${win(32, 42)}${win(62, 42)}${win(72, 42)}${door(46)}`,
    watchtower: `<rect class="b" x="42" y="18" width="16" height="40"/><rect class="b" x="38" y="12" width="24" height="7"/>${crenel(38, 62, 12, 4)}<path class="s" d="M50 24v6M50 36v6"/>${flag(50, 4)}${door(46, 8, 9)}<path class="s" d="M30 58l12-8M70 58l-12-8"/>`,
    prison: `<rect class="b" x="20" y="26" width="60" height="32"/>${crenel(20, 80, 26, 6)}<rect class="w" x="27" y="33" width="10" height="9"/><rect class="w" x="45" y="33" width="10" height="9"/><rect class="w" x="63" y="33" width="10" height="9"/><path class="s" d="M30 33v9M34 33v9M48 33v9M52 33v9M66 33v9M70 33v9"/><rect class="r" x="44" y="46" width="12" height="12"/><path class="s" d="M44 50h12M44 54h12"/>`,
    barracks: `<rect class="b" x="10" y="38" width="80" height="20"/><path class="r" d="M8 39l8-7h68l8 7z"/>${flag(20, 32)}${flag(80, 32)}<path class="r" d="M30 44h8v6l-4 3-4-3zM62 44h8v6l-4 3-4-3z"/>${door(46, 9, 12)}`,
    fortress: `<rect class="b" x="8" y="34" width="84" height="24"/>${crenel(8, 92, 34, 9)}<rect class="b" x="36" y="16" width="28" height="42"/>${crenel(36, 64, 16, 4)}<path class="r" d="M43 58V48a7 7 0 0 1 14 0v10z"/>${arch(47.5, 24, 5, 7)}${arch(16, 42)}${arch(79, 42)}`,

    // unique districts: an emblem on the purple night
    hauntedQuarter: `<path class="b" d="M38 52V30a12 12 0 0 1 24 0v22l-4-3-4 3-4-3-4 3-4-3z"/><circle class="w" cx="45" cy="31" r="2"/><circle class="w" cx="55" cy="31" r="2"/><path class="s" d="M46 39q4 3 8 0"/><path class="s" d="M14 58V40l6-5 6 5v18M74 58V36l7-6 7 6v22"/>`,
    stables: `<rect class="b" x="18" y="34" width="64" height="24"/><path class="r" d="M15 35l35-17 35 17z"/><path class="s" d="M30 46h12v12H30zM58 46h12v12H58zM30 46l12 12M58 46l12 12"/><path class="w" d="M44 24a6 6 0 1 1 12 0l-2 6h-8z"/>`,
    keep: `<rect class="b" x="34" y="16" width="32" height="42"/>${crenel(34, 66, 16, 4)}<path class="r" d="M43 58V48a7 7 0 0 1 14 0v10z"/><path class="w" d="M46 26h8v10h-8z"/><path class="s" d="M50 26v10M46 31h8"/>`,
    armory: `<path class="s" d="M26 54L72 12M74 54L28 12" style="stroke-width:2.4"/><path class="r" d="M22 50l8 8-4 2-6-6zM78 50l-8 8 4 2 6-6z"/><path class="r" d="M50 26l12 5v9c0 8-6 13-12 15-6-2-12-7-12-15v-9z"/><path class="w" d="M50 33v14M44 39h12"/>`,
    framework: `<path class="s" d="M20 58V18M44 58V18M68 58V18M20 22h48M20 38h48M20 54h48M20 22l24 16M44 22l24 16M20 38l24 16M44 38l24 16"/><path class="r" d="M70 58V36l10-8 10 8v22z"/><path class="s" d="M84 18v20M80 18h8"/>`,
    statue: `<rect class="b" x="36" y="48" width="28" height="10"/><rect class="b" x="40" y="44" width="20" height="4"/><circle class="r" cx="50" cy="18" r="5"/><path class="r" d="M44 44l2-18h8l2 18z"/><path class="s" d="M54 28l8-10M62 18l-2-3 4-1z"/><path class="w" d="M45 12l2.5-4 2.5 3 2.5-3 2.5 4z"/>`,
    basilica: `<rect class="b" x="18" y="34" width="64" height="24"/><path class="r" d="M30 34a20 18 0 0 1 40 0z"/><path class="s" d="M50 16V9M47 11h6"/><path class="s" d="M26 38v18M34 38v18M66 38v18M74 38v18"/>${arch(46, 42, 8, 16)}`,
    museum: `<path class="r" d="M16 28L50 14l34 14z"/><rect class="b" x="18" y="28" width="64" height="4"/><path class="s" d="M24 32v20M34 32v20M44 32v20M56 32v20M66 32v20M76 32v20"/><rect class="b" x="14" y="52" width="72" height="6"/><rect class="w" x="46" y="38" width="8" height="10"/>`,
    monument: `<path class="b" d="M44 54l3-40 3-6 3 6 3 40z"/><rect class="r" x="36" y="52" width="28" height="6"/><path class="s" d="M50 18v30"/><path class="w" d="M47 8l3-4 3 4z"/><path class="s" d="M24 58l6-6M76 58l-6-6"/>`,
    poorHouse: `<rect class="b" x="26" y="34" width="40" height="24"/><path class="r" d="M22 35l24-14 24 14z"/>${door(42)}<path class="b" d="M70 46h18a9 9 0 0 1-18 0z"/><path class="s" d="M74 42q2-3 0-6M80 42q2-3 0-6M86 42q2-3 0-6"/>${win(30, 40)}`,
    observatory: `<rect class="b" x="26" y="40" width="48" height="18"/><path class="r" d="M26 40a24 22 0 0 1 48 0z"/><path class="s" d="M50 34L72 12" style="stroke-width:3"/><circle class="w" cx="82" cy="10" r="2"/><circle class="w" cx="90" cy="20" r="1.4"/><circle class="w" cx="16" cy="14" r="1.6"/>${door(46)}`,
    ivoryTower: `<path class="b" d="M42 58l2-40h12l2 40z"/><path class="r" d="M40 19l10-15 10 15z"/>${arch(47.5, 26)}${arch(47.5, 40)}<path class="s" d="M38 58h24"/>`,
    laboratory: `<path class="b" d="M42 14h16M45 14v14L32 52a4 4 0 0 0 3.5 6h29a4 4 0 0 0 3.5-6L55 28V14"/><path class="w" d="M37 46h26l4 7a2 2 0 0 1-2 3H35a2 2 0 0 1-2-3z"/><circle class="w" cx="46" cy="40" r="2"/><circle class="w" cx="54" cy="36" r="1.5"/><path class="s" d="M70 20q4-4 0-8M76 24q4-4 0-8"/>`,
    smithy: `<path class="r" d="M24 36h52v6c-6 0-10 3-12 7v9H36v-9c-2-4-6-7-12-7z"/><path class="s" d="M62 12l10 10M56 18l10-10 4 4-10 10z"/><path class="w" d="M40 28l2-6 2 6M48 26l2-8 2 8M56 28l2-5 2 5"/>`,
    factory: `<rect class="b" x="12" y="34" width="76" height="24"/><path class="r" d="M12 34l19-10v10l19-10v10l19-10v10"/><rect class="b" x="72" y="12" width="8" height="22"/><path class="s" d="M76 10q4-4 0-8M70 8q3-3 0-6"/>${win(20, 42)}${win(34, 42)}${win(48, 42)}${win(62, 42)}`,
    quarry: `<path class="b" d="M6 58l14-22 10 8 12-18 16 14 10-6 26 24z"/><path class="s" d="M58 44l16-22M70 20l8 6-4 2"/><rect class="r" x="20" y="50" width="10" height="7"/><rect class="r" x="32" y="52" width="8" height="5"/>`,
    capitol: `<rect class="b" x="14" y="38" width="72" height="20"/><path class="b" d="M34 38v-6h32v6"/><path class="r" d="M36 32a14 14 0 0 1 28 0z"/><path class="s" d="M50 18V8"/><path class="r" d="M50 8h8l-3 3 3 3h-8z"/><path class="s" d="M22 42v14M30 42v14M38 42v14M62 42v14M70 42v14M78 42v14"/>`,
    mapRoom: `<path class="b" d="M18 18l20 6 24-6 20 6v34l-20-6-24 6-20-6z"/><path class="s" d="M38 24v34M62 18v34"/><path class="s" d="M24 32q8-4 12 4t14 2 16 6" stroke-dasharray="2 2"/><path class="w" d="M66 40l3 3m0-3l-3 3"/><circle class="w" cx="28" cy="44" r="2"/>`,
    imperialTreasury: `<rect class="b" x="24" y="34" width="52" height="24" rx="2"/><path class="r" d="M24 34a26 12 0 0 1 52 0z"/><rect class="r" x="45" y="38" width="10" height="9" rx="1"/><circle class="w" cx="50" cy="42" r="1.8"/><path class="s" d="M24 46h52"/><circle class="w" cx="80" cy="54" r="4"/><circle class="w" cx="18" cy="55" r="3"/>`,
    wishingWell: `<path class="b" d="M28 40h44v18H28z"/><path class="s" d="M28 46h44M36 40v18M50 40v18M64 40v18"/><path class="s" d="M32 40V22M68 40V22"/><path class="r" d="M26 23l24-12 24 12z"/><path class="s" d="M50 23v10"/><rect class="r" x="46" y="31" width="8" height="6"/><circle class="w" cx="78" cy="18" r="1.6"/>`,
    necropolis: `<path class="b" d="M18 58V38a8 8 0 0 1 16 0v20zM42 58V30a8 8 0 0 1 16 0v28zM66 58V40a8 8 0 0 1 16 0v18z"/><path class="s" d="M50 36v10M46 40h8M26 42v7M23 45h6M74 44v7M71 47h6"/><path class="w" d="M80 10a7 7 0 1 0 6 10 6 6 0 0 1-6-10z"/>`,
    greatWall: `<path class="b" d="M4 58V40l18-4 18 6 18-8 18 6 20-4v22z"/><path class="s" d="M4 40l18-4 18 6 18-8 18 6 20-4"/><rect class="b" x="28" y="24" width="12" height="18"/>${crenel(28, 40, 24, 2)}<rect class="b" x="66" y="22" width="12" height="18"/>${crenel(66, 78, 22, 2)}<path class="s" d="M10 48h12M44 50h14M80 48h12"/>`,
    library: `<rect class="b" x="18" y="16" width="64" height="42"/><path class="s" d="M18 30h64M18 44h64"/><rect class="r" x="24" y="19" width="5" height="11"/><rect class="w" x="30" y="20" width="4" height="10"/><rect class="r" x="35" y="18" width="6" height="12"/><path class="r" d="M44 30l3-11 4 1-3 10z"/><rect class="r" x="56" y="33" width="5" height="11"/><rect class="w" x="62" y="34" width="4" height="10"/><rect class="r" x="67" y="32" width="6" height="12"/><rect class="r" x="26" y="47" width="10" height="11"/><rect class="w" x="40" y="48" width="5" height="10"/>`,
    schoolOfMagic: `<path class="b" d="M38 58l3-30h18l3 30z"/><path class="r" d="M36 29l14-22 14 22z"/><path class="w" d="M70 14l2 5 5 2-5 2-2 5-2-5-5-2 5-2zM24 22l1.5 3.5L29 27l-3.5 1.5L24 32l-1.5-3.5L19 27l3.5-1.5z"/>${arch(47.5, 36)}`,
    dragonGate: `<path class="b" d="M22 58V30a28 28 0 0 1 56 0v28H66V32a16 16 0 0 0-32 0v26z"/><path class="r" d="M36 18q6-10 14-8 8-2 14 8-6-4-14-3-8-1-14 3z"/><circle class="w" cx="44" cy="16" r="1.5"/><circle class="w" cx="56" cy="16" r="1.5"/><path class="w" d="M45 44q5-8 10 0-5 6-10 0z"/>`,
    goldMine: `<path class="b" d="M16 58V34a34 30 0 0 1 68 0v24H66V38a16 16 0 0 0-32 0v20z"/><path class="s" d="M34 58h32"/><path class="r" d="M38 50h24l-3 8H41z"/><circle class="w" cx="44" cy="47" r="3"/><circle class="w" cx="51" cy="46" r="3"/><circle class="w" cx="57" cy="48" r="2.5"/>`,
    park: `<circle class="r" cx="34" cy="28" r="12"/><circle class="r" cx="62" cy="24" r="14"/><path class="s" d="M34 40v18M62 38v20"/><path class="s" d="M12 58q20-8 38-2t38 0"/><path class="b" d="M44 50h14v3H44zM46 53v5M56 53v5"/><circle class="w" cx="82" cy="12" r="3"/>`,
    thievesDen: `<path class="b" d="M14 58V42l16-12 16 12v16zM46 58V36l20-14 20 14v22z"/><path class="r" d="M52 40c4-4 24-4 28 0-2 5-8 6-14 4-6 2-12 1-14-4z"/><circle class="w" cx="59" cy="41" r="1.6"/><circle class="w" cx="73" cy="41" r="1.6"/>${door(26, 8, 10)}`,
    secretVault: `<rect class="b" x="26" y="20" width="48" height="38" rx="4"/><circle class="r" cx="50" cy="39" r="11"/><circle class="w" cx="50" cy="39" r="3"/><path class="s" d="M50 28v4M50 46v4M39 39h4M57 39h4"/><path class="s" d="M30 24h4M66 24h4M30 54h4M66 54h4"/>`,
  };

  // characters: an emblem in a medallion, with .m metal, .pg parchment, .gl glass and .rd red
  const C = {
    witch: '<path class="w" d="M13 7a8 8 0 1 0 9 12 6.5 6.5 0 0 1-9-12z"/><circle class="w" cx="50" cy="10" r="1.6"/><circle class="w" cx="44" cy="18" r="1"/>'
      + '<path class="r" d="M17 45L33 9c2-4 6-3 7 1l7 35z"/><path class="w" d="M19.5 39.5h26l1.2 5.5H18z"/><rect class="b" x="29" y="39" width="7" height="6.5" rx="1"/>'
      + '<ellipse class="r" cx="32" cy="47" rx="25" ry="5.5"/>',
    assassin: '<path class="m" d="M32 4l6.5 33h-13z"/><path class="s" d="M32 9v26"/><rect class="r" x="19" y="36" width="26" height="5" rx="2.5"/>'
      + '<rect class="b" x="28.5" y="41" width="7" height="12" rx="2"/><path class="s" d="M28.5 45h7M28.5 49h7"/><circle class="w" cx="32" cy="56" r="3.5"/>'
      + '<path class="rd" d="M46 18c2.5 4 4 6 4 8a4 4 0 0 1-8 0c0-2 1.5-4 4-8z"/>',
    thief: '<path class="b" d="M6 24c8-7 44-7 52 0-1 9-8 12-15 10-4-1-7-4-11-4s-7 3-11 4C14 36 7 33 6 24z"/><ellipse class="w" cx="22" cy="25" rx="5" ry="3.5"/><ellipse class="w" cx="42" cy="25" rx="5" ry="3.5"/>'
      + '<path class="s" d="M57 23l5-4M57 26l5 2"/><path class="r" d="M23 44c3-3 15-3 18 0l5 16H18z"/><path class="s" d="M25 43c3-4 11-4 14 0"/><circle class="w" cx="32" cy="52" r="3.5"/><path class="b" d="M31 50.5h2v3h-2z"/>',
    magician: '<circle class="gl" cx="32" cy="29" r="16"/><path class="s" d="M23 21a11 11 0 0 1 8-5"/><path class="w" d="M34 25l1.5 3.5 3.5 1.5-3.5 1.5L34 35l-1.5-3.5L29 30l3.5-1.5z"/>'
      + '<path class="r" d="M19 56l4-10h18l4 10z"/><rect class="m" x="16" y="55" width="32" height="4" rx="2"/>'
      + '<path class="w" d="M53 8l1.4 3.3 3.3 1.4-3.3 1.4L53 17.4l-1.4-3.3-3.3-1.4 3.3-1.4zM10 14l1 2.4 2.4 1-2.4 1L10 20.8l-1-2.4-2.4-1 2.4-1z"/>',
    king: '<path class="w" d="M9 45l3-27 10 12 10-19 10 19 10-12 3 27z"/><rect class="r" x="9" y="44" width="46" height="9" rx="2"/>'
      + '<circle class="rd" cx="32" cy="48.5" r="3"/><circle class="gl" cx="20" cy="48.5" r="2.4"/><circle class="gl" cx="44" cy="48.5" r="2.4"/>'
      + '<circle class="w" cx="12" cy="17" r="2.6"/><circle class="w" cx="32" cy="10" r="2.8"/><circle class="w" cx="52" cy="17" r="2.6"/>',
    abbot: '<path class="ws" d="M32 3v15M25.5 8.5h13" style="stroke-width:3.4"/>'
      + '<path class="pg" d="M32 26c-7-5-16-6-24-4v28c8-2 17-1 24 4zM32 26c7-5 16-6 24-4v28c-8-2-17-1-24 4z"/>'
      + '<path class="s" d="M32 26v28M13 29c4-1 9-1 14 1M13 35c4-1 9-1 14 1M13 41c4-1 9-1 14 1M37 30c5-2 10-2 14-1M37 36c5-2 10-2 14-1M37 42c5-2 10-2 14-1"/>'
      + '<path class="rd" d="M30 54v8l2-2 2 2v-8z"/>',
    bishop: '<path class="r" d="M18 52V28c0-10 7-18 14-23 7 5 14 13 14 23v24z"/><path class="pg" d="M18 44h28v8H18z"/>'
      + '<path class="ws" d="M32 14v22M25 22h14" style="stroke-width:3"/><path class="s" d="M32 5v39"/>'
      + '<path class="ws" d="M51 60V21a6.5 6.5 0 1 0-9-6" style="stroke-width:3.2"/>',
    merchant: '<path class="b" d="M23 22l4-8 5 6 5-6 4 8z"/><path class="r" d="M21 25c-9 9-9 33 11 33s20-24 11-33z"/><path class="ws" d="M20 25h24" style="stroke-width:3"/>'
      + '<circle class="w" cx="32" cy="42" r="6"/><path class="b" d="M31 38.5h2v7h-2z"/>'
      + '<ellipse class="w" cx="52" cy="56" rx="8" ry="3"/><ellipse class="w" cx="52" cy="51.5" rx="8" ry="3"/><ellipse class="w" cx="52" cy="47" rx="8" ry="3"/>'
      + '<ellipse class="w" cx="10" cy="55" rx="6" ry="2.6"/>',
    architect: '<path class="pg" d="M6 58V30l26 28z"/><path class="s" d="M10 40v14h14"/>'
      + '<path class="m" d="M32 11L19 53l3 1 10-34 10 34 3-1z"/><circle class="w" cx="32" cy="10" r="4.5"/><path class="s" d="M24 42c5 3 11 3 16 0"/>'
      + '<path class="r" d="M47 50l9-30 3 1-9 30-3 1z"/>',
    diplomat: '<rect class="pg" x="15" y="15" width="34" height="32"/><rect class="pg" x="10" y="10" width="44" height="8" rx="4"/><rect class="pg" x="10" y="44" width="44" height="8" rx="4"/>'
      + '<path class="s" d="M20 24h24M20 29h24M20 34h17M20 39h20"/>'
      + '<path class="rd" d="M40 50l-3 11 5-3 4 3-1-11z"/><circle class="rd" cx="43" cy="48" r="7"/><circle class="w" cx="43" cy="48" r="2.4"/>',
    warlord: '<path class="ms" d="M8 54L50 8M56 54L14 8" style="stroke-width:3.4"/><path class="rd" d="M32 13c4-6 12-7 16-4-6 0-10 3-12 7z"/>'
      + '<path class="m" d="M16 42c0-16 7-25 16-25s16 9 16 25v8h-8v-8H24v8h-8z"/><path class="b" d="M22 32h20v5H22z"/><path class="s" d="M32 17v15"/>',
    queen: '<path class="w" d="M8 40c12-6 36-6 48 0l-4-14-8 6-12-20-12 20-8-6z"/><circle class="rd" cx="32" cy="28" r="3.5"/><circle class="gl" cx="20" cy="33" r="2"/><circle class="gl" cx="44" cy="33" r="2"/>'
      + '<path class="r" d="M8 40c12-6 36-6 48 0v5c-12-6-36-6-48 0z"/>'
      + '<circle class="rd" cx="32" cy="54" r="6"/><path class="s" d="M29 54a3 3 0 0 1 5-2M32 57a3 3 0 0 1-3-3"/><path class="s" d="M26 58l-6 4M38 58l6 4"/>',
  };

  // far away behind every district: a faint skyline and the moon
  const back = '<path class="bg" d="M0 58V46h7v-5h5v7h6V38h4v-4h3v4h4v10h6v-6h7v16zM70 58V44h5v-6h4v6h6v-9h5v9h6v4h4v10z"/><circle class="moon" cx="86" cy="12" r="5"/>';

  return {
    district: kind => `<svg class="art" viewBox="0 0 100 64" aria-hidden="true">${back}${D[kind] || ''}${D[kind] && !kind.match(/docks|harbor|quarry|greatWall|park|necropolis/) ? gnd : ''}</svg>`,
    character: c => `<svg class="art" viewBox="0 0 64 64" aria-hidden="true">${C[c] || ''}</svg>`,
  };
})();
