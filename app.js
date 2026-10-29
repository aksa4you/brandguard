(function () {
  'use strict';
  const BG = window.BG;
  const KEY = 'brandguard.v1';

  const ROLES = {
    creator: { name: 'Priya Nair', label: 'Creator' },
    reviewer: { name: 'Sana Qureshi', label: 'Reviewer' },
    manager: { name: 'Arjun Mehta', label: 'Brand manager' }
  };
  const CHANNELS = ['Instagram post', 'Email', 'Web banner', 'Press note', 'SMS', 'Help-centre article', 'Other'];
  const REASONS = ['Approved exception', 'False positive', 'Guideline unclear', 'Other'];
  const CAT = { terminology: 'Terminology', tone: 'Tone', claims: 'Claims', facts: 'Facts', accessibility: 'Accessibility', visual: 'Visual' };
  const STATUS = { draft: ['Draft', 'neutral'], in_review: ['In review', 'accent'], changes_requested: ['Changes requested', 'medium'], approved: ['Approved', 'ok'] };
  const RULE_LABEL = {
    'tone.banned': 'Off-brand word', 'tone.exclaim': 'Too many exclamation marks', 'tone.caps': 'ALL-CAPS words', 'clarity.long': 'Sentence too long',
    'claims.unsupported': 'Unsupported claim', 'claims.qualifier': 'Claim missing its qualifier', 'claims.disclaimer': 'Missing legal qualifier',
    'facts.price': 'Wrong price', 'facts.validity': 'Wrong validity period', 'facts.retired': 'Retired plan quoted',
    'a11y.alt-missing': 'Image without alt text', 'a11y.alt-generic': 'Generic alt text', 'a11y.alt-long': 'Alt text too long',
    'a11y.link-text': 'Vague link text', 'a11y.hashtag': 'Hashtag not CamelCase', 'a11y.contrast': 'Low text contrast',
    'visual.logo-size': 'Logo too small', 'visual.logo-stretch': 'Logo stretched', 'visual.logo-bg': 'Logo on unapproved background',
    'visual.palette': 'Off-palette colour', 'visual.resolution': 'Low-resolution photo'
  };

  const E = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const uid = () => Math.random().toString(36).slice(2, 9);
  const fmt = (t) => new Date(t).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
  const clone = (o) => JSON.parse(JSON.stringify(o));
  const todayISO = () => new Date().toISOString().slice(0, 10);
  const DAY = 864e5;

  /* ---------------- state ---------------- */
  let S = null;
  let kitStamp = 1;
  const memo = new Map();

  function blankDraft() { return { title: '', channel: CHANNELS[0], text: '', images: [] }; }

  function loadSaved() {
    try { const raw = localStorage.getItem(KEY); if (raw) return JSON.parse(raw); } catch (e) { /* storage unavailable */ }
    return null;
  }
  function save() {
    try { localStorage.setItem(KEY, JSON.stringify({ kit: S.kit, docs: S.docs })); } catch (e) { /* ignore */ }
  }

  function init() {
    const saved = loadSaved();
    S = {
      role: 'creator', view: 'new', currentId: null,
      kit: saved && saved.kit ? saved.kit : clone(BG.sampleKit),
      docs: saved && saved.docs ? saved.docs : [],
      draft: blankDraft(), toast: '',
      ui: { selected: null, cat: 'all', status: 'all', dismissing: null, editing: null, tab: 'activity', viewVer: null, editText: false, ack: {}, rc: '', comment: '', docFilter: 'all' }
    };
    if (!saved || !saved.docs) { S.docs = seedDocs(); save(); }
    S.draft = sampleDraft(0);
  }

  const curDoc = () => S.docs.find((d) => d.id === S.currentId) || null;
  const curVer = (doc) => doc.versions[doc.versions.length - 1];
  const user = (role) => ROLES[role || S.role].name;

  function analyzeDoc(doc, ver) {
    const k = doc.id + ':' + ver.n + ':' + kitStamp + ':' + (ver.images || []).length;
    if (memo.has(k)) return memo.get(k);
    const r = BG.analyzeVersion(ver, S.kit, { today: todayISO() });
    memo.set(k, r);
    return r;
  }

  function stats(doc) {
    const ver = curVer(doc);
    const { findings, verified } = analyzeDoc(doc, ver);
    let open = 0, decided = 0, pendingApply = 0;
    // High-severity findings a reviewer must personally confirm: dismissed by the creator, or
    // marked "I will fix this" (no automatic fix exists) while still present in this version.
    const highDismissed = [];
    let highUnfixed = 0;
    for (const f of findings) {
      const d = doc.decisions[f.key];
      if (!d) { open++; continue; }
      decided++;
      if (d.status === 'accepted' && f.suggestion) pendingApply++;
      if (d.status === 'edited') pendingApply++;
      if (f.severity === 'high' && d.status === 'dismissed') highDismissed.push(f);
      if (f.severity === 'high' && d.status === 'accepted' && !f.suggestion) { highDismissed.push(f); highUnfixed++; }
    }
    return { findings, verified, open, decided, pendingApply, highDismissed, highUnfixed, high: findings.filter((f) => f.severity === 'high').length };
  }

  function log(doc, text, type) {
    doc.events.push({ id: uid(), at: Date.now(), by: user(), role: S.role, type: type || 'event', text });
  }

  const meta = (f) => ({ rule: f.rule, refType: f.refType, refId: f.refId, guidelineId: f.guidelineId, category: f.category, severity: f.severity });

  /* ---------------- document operations ---------------- */
  function rollVersion(doc, text, images, note, by) {
    const prev = analyzeDoc(doc, curVer(doc)).findings;
    const n = curVer(doc).n + 1;
    doc.versions.push({ n, text, images, at: Date.now(), by: by || user(), note });
    const next = analyzeDoc(doc, curVer(doc)).findings;
    const keys = new Set(next.map((f) => f.key));
    for (const f of prev) {
      if (keys.has(f.key)) continue;
      const d = doc.decisions[f.key];
      doc.resolved.push(Object.assign(meta(f), { key: f.key, outcome: d ? d.status : 'fixed', reason: d ? d.reason : '', ver: n - 1 }));
      delete doc.decisions[f.key];
    }
    return n;
  }

  function applyAccepted(doc) {
    const ver = curVer(doc);
    const { findings } = analyzeDoc(doc, ver);
    const edits = [];
    const images = clone(ver.images || []);
    let imgChanges = 0;
    for (const f of findings) {
      const d = doc.decisions[f.key];
      if (!d) continue;
      if (f.target && f.target.type === 'image') {
        if (d.status === 'edited' && f.rule.startsWith('a11y.alt')) {
          const im = images.find((x) => x.id === f.target.id);
          if (im) { im.alt = d.replacement; imgChanges++; }
        }
        continue;
      }
      if (d.status === 'accepted' && f.suggestion) edits.push(f.suggestion);
      else if (d.status === 'edited') { const r = f.suggestion || f; edits.push({ start: r.start, end: r.end, replacement: d.replacement }); }
    }
    const res = BG.applyEdits(ver.text, edits);
    if (!res.applied.length && !imgChanges) return 0;
    const n = rollVersion(doc, res.text, images, 'Applied ' + (res.applied.length + imgChanges) + ' accepted change' + (res.applied.length + imgChanges === 1 ? '' : 's'));
    log(doc, 'created version ' + n + ' with ' + (res.applied.length + imgChanges) + ' accepted change(s)');
    return res.applied.length + imgChanges;
  }

  /* ---------------- sample content ---------------- */
  const SAMPLE_TEXT = [
    { title: 'Diwali recharge offer', channel: 'Instagram post', text: "Diwali dhamaka!! Grab our CHEAP top-up packages today. The Everyday plan is now just ₹279 for 28 days. Unlimited calls for every subscriber. India's #1 network! #diwalirecharge" },
    { title: 'Lucknow 5G announcement', channel: 'Press note', text: "Tarang has the fastest 5G in Lucknow. Our helpline is open 24 hours a day. Customers still on the Value 249 plan can move to the Everyday plan for ₹349 and get 30 days of validity. Read the details [here](https://tarang.example/5g)." }
  ];
  function sampleDraft(i) { const s = SAMPLE_TEXT[i % SAMPLE_TEXT.length]; return { title: s.title, channel: s.channel, text: s.text, images: [] }; }

  function seedDocs() {
    const specs = [
      { t: 'Diwali recharge offer', c: 'Instagram post', who: 'Meera Joshi', days: 12, status: 'approved',
        text: "Diwali dhamaka!! Grab our CHEAP top-up packages today. The Everyday plan is now just ₹279 for 28 days. Unlimited calls for every subscriber. India's #1 network! #diwalirecharge",
        policy: (f) => (f.rule === 'tone.exclaim' ? ['dismissed', 'Approved exception'] : ['accepted']) },
      { t: 'Weekender launch email', c: 'Email', who: 'Rohan Das (agency)', days: 9, status: 'approved',
        text: 'Meet the Weekender plan: ₹99 for 7 days of data and calls. Free SIM delivery to your door. Our users tell us it is the cheapest way to stay connected on weekends, and we are proud that every customer gets guaranteed network quality in all the cities where we operate across the whole country. [click here](https://tarang.example/weekender) to learn more.',
        policy: (f) => (f.rule === 'clarity.long' ? ['dismissed', 'Guideline unclear'] : ['accepted']) },
      { t: 'Lucknow 5G press note', c: 'Press note', who: 'Priya Nair', days: 3, status: 'in_review',
        text: 'Tarang has the fastest 5G in Lucknow. Our helpline is open 24 hours a day. Customers on the Value 249 plan can move to the Everyday plan at ₹299 for 28 days.',
        policy: () => ['accepted'] },
      { t: 'Annual Saver web banner', c: 'Web banner', who: 'Meera Joshi', days: 2, status: 'changes_requested',
        text: 'Annual Saver plan at ₹2999 for 365 days. Unlimited data. Best network coverage in India. ![banner](banner.png)',
        policy: (f) => (f.rule === 'terminology' ? ['accepted'] : null) },
      { t: 'Number portability FAQ', c: 'Help-centre article', who: 'Rohan Das (agency)', days: 7, status: 'approved',
        text: 'If you are a subscriber who has recently moved to a different city and wishes to keep the same number while updating the address on the account, you should visit the nearest Tarang store with valid ID proof and the original SIM card, or contact customer care to schedule a doorstep visit at a convenient time. Once your request is accepted, the change usually takes effect within a few working days and you will receive a confirmation message on the new address and on the registered number.',
        policy: (f) => (f.rule === 'clarity.long' ? ['dismissed', 'Guideline unclear'] : ['accepted']) },
      { t: 'Weekender expiry SMS', c: 'SMS', who: 'Priya Nair', days: 5, status: 'approved',
        text: 'Your Weekender plan expires in 2 days. Top up now for ₹129 to keep going!!',
        policy: (f) => (f.rule === 'tone.exclaim' ? ['dismissed', 'Approved exception'] : ['accepted']) },
      { t: 'Roaming advisory', c: 'Help-centre article', who: 'Rohan Das (agency)', days: 6, status: 'approved',
        text: 'When you travel outside the country for work or leisure and wish to keep your Tarang number active for calls and messages, you should switch on international roaming from the app before you leave so that your connection is ready the moment you land. Charges for calls received abroad depend on the country you visit, and the rates are listed on the roaming page of the website for every region that we currently support.',
        policy: (f) => (f.rule === 'clarity.long' ? ['dismissed', 'Guideline unclear'] : ['accepted']) }
    ];
    return specs.map((s) => {
      const at = Date.now() - s.days * DAY;
      const doc = { id: uid(), sample: true, title: s.t, channel: s.c, ownerRole: 'creator', ownerName: s.who, created: at, status: 'draft',
        versions: [{ n: 1, text: s.text, images: [], at, by: s.who, note: 'First submission' }], decisions: {}, resolved: [], events: [{ id: uid(), at, by: s.who, role: 'creator', type: 'event', text: 'submitted the first draft' }], approval: null };
      const { findings } = analyzeDoc(doc, doc.versions[0]);
      findings.forEach((f, i) => {
        const p = s.policy(f);
        if (!p) return;
        if (s.status === 'changes_requested' && i % 3 === 2) return;
        doc.decisions[f.key] = Object.assign(meta(f), { status: p[0], reason: p[1] || '', by: 'creator', at: at + 3600e3 });
      });
      S = S || { docs: [], kit: BG.sampleKit };
      const saveRole = S.role; S.role = 'creator';
      applyAccepted(doc);
      S.role = saveRole;
      if (s.status === 'in_review' || s.status === 'approved') doc.events.push({ id: uid(), at: at + 7200e3, by: s.who, role: 'creator', type: 'event', text: 'submitted for review' });
      if (s.status === 'approved') {
        doc.events.push({ id: uid(), at: at + 86400e3, by: ROLES.reviewer.name, role: 'reviewer', type: 'event', text: 'approved version ' + curVer(doc).n });
        doc.approval = { by: ROLES.reviewer.name, at: at + 86400e3, version: curVer(doc).n, acknowledged: [] };
      }
      if (s.status === 'changes_requested') {
        doc.events.push({ id: uid(), at: at + 7200e3, by: s.who, role: 'creator', type: 'event', text: 'submitted for review' });
        doc.events.push({ id: uid(), at: at + 86400e3, by: ROLES.reviewer.name, role: 'reviewer', type: 'comment', text: 'Changes requested: please add real alt text for the banner and settle the coverage claim before this goes out.' });
      }
      doc.status = s.status;
      return doc;
    });
  }

  /* ---------------- image & file import ---------------- */
  function processImage(file) {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onerror = () => reject(new Error('Could not read the image'));
      fr.onload = () => {
        const im = new Image();
        im.onerror = () => reject(new Error('This file is not a readable image'));
        im.onload = () => {
          const w = im.naturalWidth, h = im.naturalHeight;
          const sc = Math.min(1, 240 / Math.max(w, h));
          const c = document.createElement('canvas');
          c.width = Math.max(1, Math.round(w * sc)); c.height = Math.max(1, Math.round(h * sc));
          const ctx = c.getContext('2d');
          ctx.drawImage(im, 0, 0, c.width, c.height);
          const thumb = c.toDataURL(file.type === 'image/png' ? 'image/png' : 'image/jpeg', 0.72);
          const c2 = document.createElement('canvas'); c2.width = 48; c2.height = 48;
          const x2 = c2.getContext('2d'); x2.drawImage(im, 0, 0, 48, 48);
          const px = x2.getImageData(0, 0, 48, 48).data;
          const buckets = new Map(); let total = 0;
          for (let i = 0; i < px.length; i += 4) {
            if (px[i + 3] < 128) continue;
            total++;
            const k = ((px[i] >> 4) << 8) | ((px[i + 1] >> 4) << 4) | (px[i + 2] >> 4);
            buckets.set(k, (buckets.get(k) || 0) + 1);
          }
          const dominant = [...buckets.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, n]) =>
            ({ hex: BG.rgbToHex(((k >> 8) << 4) + 8, (((k >> 4) & 15) << 4) + 8, ((k & 15) << 4) + 8), share: n / Math.max(1, total) }));
          resolve({ id: uid(), name: file.name, width: w, height: h, thumb, dominant, role: /logo/i.test(file.name) ? 'logo' : 'photo', alt: '', textColor: '', bgColor: '' });
        };
        im.src = fr.result;
      };
      fr.readAsDataURL(file);
    });
  }

  async function readTextFile(file) {
    if (/\.pdf$/i.test(file.name)) {
      if (!window.pdfjsLib) throw new Error('The PDF reader is not available. Paste the text instead.');
      const pdf = await window.pdfjsLib.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
      const pages = [];
      for (let p = 1; p <= pdf.numPages; p++) {
        const tc = await (await pdf.getPage(p)).getTextContent();
        let out = '', lastY = null;
        for (const it of tc.items) {
          if (typeof it.str !== 'string') continue;
          const y = it.transform ? it.transform[5] : null, h = Math.abs(it.height || (it.transform && it.transform[3]) || 10) || 10;
          if (lastY !== null && y !== null && Math.abs(y - lastY) > 0.5 && out) {
            const gap = Math.abs(y - lastY);
            out += gap > h * 1.9 ? '\n\n' : (/\s$/.test(out) ? '' : ' ');
          }
          out += it.str;
          if (y !== null && it.str.trim()) lastY = y;
        }
        pages.push(out.trim());
      }
      const text = pages.filter(Boolean).join('\n\n').replace(/[ \t]+/g, ' ').replace(/ ?\n ?/g, '\n').trim();
      if (!text) throw new Error('No text found in this PDF. It may be a scan; paste the text instead.');
      return text;
    }
    if (/\.docx$/i.test(file.name)) {
      if (!window.JSZip) throw new Error('The Word reader is not available. Paste the text instead.');
      const zip = await window.JSZip.loadAsync(await file.arrayBuffer());
      const xml = await zip.file('word/document.xml').async('string');
      return xml.replace(/<\/w:p>/g, '\n').replace(/<w:tab\/>/g, '\t').replace(/<[^>]+>/g, '')
        .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/\n{3,}/g, '\n\n').trim();
    }
    return (await file.text()).trim();
  }

  /* ---------------- rendering helpers ---------------- */
  const sevName = { high: 'High', medium: 'Medium', low: 'Low' };

  function sourceHtml(f) {
    const kit = S.kit;
    const g = kit.guidelines.find((x) => x.id === f.guidelineId);
    let ref = '';
    if (f.refType === 'term') { const t = kit.terms.find((x) => x.id === f.refId); if (t) ref = 'Approved term <b>' + E(t.id) + '</b>: use “' + E(t.preferred) + '”.'; }
    else if (f.refType === 'fact') {
      const x = kit.facts.find((y) => y.id === f.refId);
      if (x) ref = x.status === 'retired' ? 'Fact sheet <b>' + E(x.id) + '</b>: ' + E(x.name) + ' is retired (' + E(x.source) + ').'
        : 'Approved fact <b>' + E(x.id) + '</b>: ' + E(x.name) + ', ' + BG_inr(x.price) + ' for ' + x.validityDays + ' days (' + E(x.source) + ').';
    } else if (f.refType === 'evidence') {
      const x = kit.evidence.find((y) => y.id === f.refId);
      if (x) ref = 'Evidence <b>' + E(x.id) + '</b>: ' + E(x.source) + ', scope ' + E(x.scope) + ', ' + E(x.status) + ', valid to ' + E(x.expires) + '.';
    } else if (f.refType === 'claimRule') {
      const x = kit.claimRules.find((y) => y.id === f.refId);
      if (x) ref = 'Claim rule <b>' + E(x.id) + '</b> (' + E(x.label) + ').';
    }
    return '<div class="source">' + (g ? '<b>' + E(g.id) + '</b> ' + E(g.section) + ': “' + E(g.text) + '”' : '') + (ref ? '<br>' + ref : '') + '</div>';
  }
  function BG_inr(n) { return '₹' + Number(n).toLocaleString('en-IN'); }

  function diffHtml(f, text) {
    const s = f.suggestion;
    if (!s) return f.advice ? '<div class="advice">' + E(f.advice) + '</div>' : '';
    if (s.start === s.end) return '<div class="diff"><span class="muted">Add</span> <ins>' + E(s.replacement.trim()) + '</ins></div>';
    return '<div class="diff"><del>' + E(text.slice(s.start, s.end)) + '</del> <span aria-hidden="true">→</span> <ins>' + E(s.replacement) + '</ins></div>';
  }

  function markedText(text, findings, decisions, sel, readOnly) {
    const ranged = findings.filter((f) => f.start != null && f.end > f.start);
    const pts = new Set([0, text.length]);
    ranged.forEach((f) => { pts.add(f.start); pts.add(f.end); });
    const bps = [...pts].sort((a, b) => a - b);
    const rank = { high: 3, medium: 2, low: 1 };
    let html = '';
    for (let i = 0; i < bps.length - 1; i++) {
      const a = bps[i], b = bps[i + 1];
      const seg = text.slice(a, b);
      const act = ranged.filter((f) => f.start <= a && f.end >= b);
      if (!act.length) { html += E(seg); continue; }
      const top = act.slice().sort((x, y) => rank[y.severity] - rank[x.severity])[0];
      const done = !readOnly && act.every((f) => decisions[f.key]);
      html += '<span class="hl ' + top.severity + (done ? ' done' : '') + (act.some((f) => f.key === sel) ? ' sel' : '') + '" tabindex="0" role="button" data-a="select" data-key="' + E(top.key) +
        '" title="' + E(top.message) + '">' + E(seg) + '</span>';
    }
    return html;
  }

  /* ---------------- views ---------------- */
  function shell(body) {
    const queueN = S.docs.filter((d) => d.status === 'in_review').length;
    const tabs = [['new', 'New submission'], ['review', 'Review'], ['queue', 'Queue'], ['kit', 'Brand kit'], ['insights', 'Insights'], ['about', 'AI and privacy']];
    return '<div class="wrap"><header class="top"><div class="brand"><b>BrandGuard</b><span>Pre-publication review</span></div>' +
      '<div class="who"><span class="pill neutral">' + E(S.kit.org) + '</span><label for="role">Signed in as</label>' +
      '<select id="role" data-change="role">' + Object.keys(ROLES).map((r) => '<option value="' + r + '"' + (r === S.role ? ' selected' : '') + '>' + E(ROLES[r].name) + ' (' + ROLES[r].label + ')</option>').join('') + '</select></div></header>' +
      '<nav class="nav" aria-label="Sections">' + tabs.map((t) => '<button data-a="nav" data-view="' + t[0] + '"' + (S.view === t[0] ? ' aria-current="page"' : '') + '>' + t[1] +
        (t[0] === 'queue' && queueN ? '<span class="count">' + queueN + ' to review</span>' : '') + '</button>').join('') + '</nav>' +
      '<main>' + body + '</main>' +
      '<footer>Checks run in your browser against the approved sources in the Brand kit. Nothing you paste is sent to a server or an AI service. Sample reviews are marked “sample”. <button class="btn sm ghost" data-a="resetDemo">Reset demo data</button></footer></div>' +
      (S.toast ? '<div class="toast" role="status">' + E(S.toast) + '</div>' : '');
  }

  function viewNew() {
    const d = S.draft;
    const canSubmit = S.role !== 'reviewer';
    const imgs = d.images.map((im, i) => '<div class="img"><img alt="" src="' + E(im.thumb) + '"><div><div class="n">' + E(im.name) + '</div><div class="muted mono">' + im.width + '×' + im.height + 'px</div>' +
      '<div class="fields" style="grid-template-columns:1fr 1fr;margin-top:6px">' +
      '<div class="field"><label for="ir' + i + '">Use</label><select id="ir' + i + '" data-img="' + i + '" data-f="role">' + ['logo', 'graphic', 'photo'].map((r) => '<option' + (im.role === r ? ' selected' : '') + '>' + r + '</option>').join('') + '</select></div>' +
      '<div class="field"><label for="ia' + i + '">Alt text</label><input type="text" id="ia' + i + '" data-img="' + i + '" data-f="alt" value="' + E(im.alt) + '"></div>' +
      '<div class="field"><label for="it' + i + '">Text colour</label><input type="text" id="it' + i + '" placeholder="#RRGGBB" data-img="' + i + '" data-f="textColor" value="' + E(im.textColor) + '"></div>' +
      '<div class="field"><label for="ib' + i + '">Background</label><input type="text" id="ib' + i + '" placeholder="#RRGGBB" data-img="' + i + '" data-f="bgColor" value="' + E(im.bgColor) + '"></div></div>' +
      '<div class="swatches" aria-label="Dominant colours">' + im.dominant.slice(0, 5).map((c) => '<i style="background:' + E(c.hex) + '" title="' + E(c.hex) + ' ' + Math.round(c.share * 100) + '%"></i>').join('') + '</div>' +
      '<button class="btn sm ghost" data-a="removeImg" data-i="' + i + '">Remove</button></div></div>').join('');
    return '<div class="grid2"><section class="card pad stack" aria-labelledby="newh"><div><h1 id="newh" style="font-size:22px">Check a draft before it is published</h1>' +
      '<p class="muted" style="margin:6px 0 0">Paste copy, import a text, Word or PDF file, and attach images. BrandGuard checks it against the approved guidelines, terms, facts and assets, then explains every issue. You decide what changes.</p></div>' +
      (canSubmit ? '' : '<div class="notice">Reviewers review submissions made by others. Switch to Priya Nair (Creator) to submit a draft.</div>') +
      '<div class="fields"><div class="field"><label for="dt">Title</label><input type="text" id="dt" data-draft="title" value="' + E(d.title) + '" placeholder="Name this piece"></div>' +
      '<div class="field"><label for="dc">Channel</label><select id="dc" data-draft="channel">' + CHANNELS.map((c) => '<option' + (c === d.channel ? ' selected' : '') + '>' + c + '</option>').join('') + '</select></div></div>' +
      '<div class="field"><label for="dtext">Copy</label><textarea id="dtext" class="paper-input" data-draft="text" placeholder="Paste the copy to review">' + E(d.text) + '</textarea></div>' +
      '<div class="row"><label class="btn sm" for="ftxt">Import .txt, .md, .docx or .pdf</label><input id="ftxt" class="sr" type="file" accept=".txt,.md,.docx,.pdf" data-file="text">' +
      '<label class="btn sm" for="fimg">Attach image</label><input id="fimg" class="sr" type="file" accept="image/*" data-file="image">' +
      '<button class="btn sm ghost" data-a="sample" data-i="0">Load sample: Diwali offer</button><button class="btn sm ghost" data-a="sample" data-i="1">Load sample: 5G announcement</button></div>' +
      (imgs ? '<div class="imgs">' + imgs + '</div>' : '') +
      '<div class="row"><button class="btn primary" data-a="run"' + (canSubmit ? '' : ' disabled') + '>Run brand check</button><span class="muted">About a second. Runs on this device.</span></div></section>' +
      '<aside class="stack"><div class="card pad stack"><h2 style="font-size:16px">What gets checked</h2><div class="list">' +
      [['Terminology', 'Approved terms, such as “recharge” not “top-up”.'], ['Tone', 'Hype words, shouting, long sentences.'], ['Claims', 'Superlatives and rankings need current evidence and the approved qualifier.'], ['Facts', 'Prices and validity against the plan sheet, retired plans.'], ['Accessibility', 'Alt text, link text, hashtags, text contrast.'], ['Visual', 'Logo size and proportions, palette, resolution.']]
        .map((x) => '<div><b>' + x[0] + '</b><div class="muted">' + x[1] + '</div></div>').join('') + '</div></div>' +
      '<div class="notice">Every finding names the guideline or approved source behind it. Suggestions keep your meaning and are never applied without a human decision.</div></aside></div>';
  }

  function findingCard(f, doc, ver, editable) {
    const d = doc.decisions[f.key];
    const sel = S.ui.selected === f.key;
    const isImg = f.target && f.target.type === 'image';
    const altRule = isImg && f.rule.startsWith('a11y.alt');
    let actions = '';
    if (d) {
      const word = { accepted: f.suggestion ? 'Accepted' : 'Acknowledged', edited: 'Edited', dismissed: 'Dismissed' }[d.status];
      actions = '<div class="status-line"><span class="pill ' + (d.status === 'dismissed' ? 'neutral' : 'ok') + '">' + word + '</span><span class="muted">' + E(user(d.by)) + ', ' + fmt(d.at) + '</span>' +
        (d.status === 'dismissed' ? '<span class="muted">Reason: ' + E(d.reason) + (d.note ? ' · ' + E(d.note) : '') + '</span>' : '') +
        (d.status === 'edited' ? '<span class="muted">New text: <span class="mono">' + E(d.replacement) + '</span></span>' : '') +
        ((d.status === 'dismissed' || (d.status === 'accepted' && !f.suggestion)) && f.severity === 'high' ? '<span class="pill high">Needs reviewer sign-off</span>' : '') +
        (editable ? '<button class="btn sm ghost" data-a="undo" data-key="' + E(f.key) + '">Undo</button>' : '') + '</div>';
    } else if (editable) {
      if (S.ui.dismissing === f.key) {
        actions = '<div class="inline-form"><label class="sr" for="why-' + E(f.key) + '">Reason</label><select id="why-' + E(f.key) + '" data-role="reason">' + REASONS.map((r) => '<option>' + r + '</option>').join('') + '</select>' +
          '<input type="text" data-role="note" aria-label="Note" placeholder="Optional note for the reviewer"><div class="row"><button class="btn sm primary" data-a="dismissSave" data-key="' + E(f.key) + '">Confirm dismissal</button><button class="btn sm" data-a="cancelUi">Cancel</button></div></div>';
      } else if (S.ui.editing === f.key) {
        const base = altRule ? ((ver.images || []).find((x) => x.id === f.target.id) || {}).alt || '' : (f.suggestion ? f.suggestion.replacement : '');
        actions = '<div class="inline-form"><label for="ed-' + E(f.key) + '" class="muted">' + (altRule ? 'New alt text' : 'Your wording') + '</label><input type="text" id="ed-' + E(f.key) + '" data-role="edit" value="' + E(base) + '">' +
          '<div class="row"><button class="btn sm primary" data-a="editSave" data-key="' + E(f.key) + '">Use my wording</button><button class="btn sm" data-a="cancelUi">Cancel</button></div></div>';
      } else {
        actions = '<div class="row">' +
          (f.suggestion ? '<button class="btn sm primary" data-a="accept" data-key="' + E(f.key) + '">Accept suggestion</button><button class="btn sm" data-a="editStart" data-key="' + E(f.key) + '">Edit</button>'
            : altRule ? '<button class="btn sm primary" data-a="editStart" data-key="' + E(f.key) + '">Write alt text</button>' : '<button class="btn sm primary" data-a="accept" data-key="' + E(f.key) + '">I will fix this</button>') +
          '<button class="btn sm" data-a="dismissStart" data-key="' + E(f.key) + '">Dismiss</button></div>';
      }
    }
    return '<article class="finding ' + f.severity + (d ? ' decided' : '') + (sel ? ' sel' : '') + '" id="f-' + E(f.key) + '" data-key="' + E(f.key) + '">' +
      '<div class="row"><span class="pill ' + f.severity + '">' + sevName[f.severity] + '</span><span class="pill neutral">' + CAT[f.category] + '</span><span class="muted mono" style="margin-left:auto">' + Math.round(f.confidence * 100) + '% confidence</span></div>' +
      '<h4>' + E(f.message) + '</h4>' +
      '<div><span class="excerpt">' + E(f.excerpt) + '</span></div>' +
      '<div class="why">' + E(f.why) + '</div>' + sourceHtml(f) + diffHtml(f, ver.text) + actions + '</article>';
  }

  function viewReview() {
    const doc = curDoc();
    if (!doc) {
      const pending = S.docs.filter((d) => d.status === 'in_review').length;
      return '<div class="card empty"><h2 style="font-size:18px;color:var(--ink)">No document open</h2><p>Start a check from “New submission”, or open one from the queue.' + (pending ? ' ' + pending + ' awaiting review.' : '') + '</p><button class="btn primary" data-a="nav" data-view="new">New submission</button> <button class="btn" data-a="nav" data-view="queue">Open queue</button></div>';
    }
    const cur = curVer(doc);
    const shown = S.ui.viewVer ? doc.versions.find((v) => v.n === S.ui.viewVer) || cur : cur;
    const readOnly = shown !== cur;
    const st = stats(doc);
    const an = readOnly ? analyzeDoc(doc, shown) : { findings: st.findings, verified: st.verified };
    const role = S.role;
    const editable = !readOnly && ['draft', 'changes_requested'].includes(doc.status) && role !== 'reviewer';
    const [stLabel, stCls] = STATUS[doc.status];
    const owner = '<span class="muted">' + E(doc.ownerName) + ' · ' + E(doc.channel) + ' · version ' + cur.n + (doc.sample ? ' · <span class="pill neutral">sample</span>' : '') + '</span>';

    // left: the copy
    let left = '';
    if (readOnly) left += '<div class="vbanner">Viewing version ' + shown.n + ' (read-only). <button class="btn sm" data-a="viewVer" data-n="">Back to version ' + cur.n + '</button></div>';
    if (S.ui.editText && editable) {
      left += '<label class="sr" for="etext">Edit copy</label><textarea id="etext" class="editor">' + E(cur.text) + '</textarea><div class="row" style="margin-top:8px"><button class="btn primary" data-a="saveText">Save as version ' + (cur.n + 1) + '</button><button class="btn" data-a="cancelText">Cancel</button></div>';
    } else {
      left += '<div class="paper" id="paper">' + markedText(shown.text, an.findings, readOnly ? {} : doc.decisions, S.ui.selected, readOnly) + '</div>';
    }
    if ((shown.images || []).length) {
      left += '<div class="imgs">' + shown.images.map((im) => {
        const n = an.findings.filter((f) => f.target && f.target.id === im.id).length;
        return '<div class="img"><img alt="' + E(im.alt) + '" src="' + E(im.thumb) + '"><div><div class="n">' + E(im.name) + '</div><div class="muted mono">' + im.role + ' · ' + im.width + '×' + im.height + 'px</div>' +
          '<div class="muted" style="font-size:12.5px">Alt: ' + (im.alt ? E(im.alt) : '<i>none</i>') + '</div>' + (n ? '<span class="pill medium">' + n + ' finding' + (n > 1 ? 's' : '') + '</span>' : '<span class="pill ok">No findings</span>') + '</div></div>';
      }).join('') + '</div>';
    }
    left += '<div class="row" style="margin-top:12px">' +
      (editable ? '<button class="btn" data-a="editText"' + (S.ui.editText ? ' disabled' : '') + '>Edit copy</button><label class="btn" for="addimg">Add image</label><input id="addimg" class="sr" type="file" accept="image/*" data-file="addimage">' : '') +
      '<span class="muted">Click a highlight to jump to its explanation.</span></div>';

    // right: findings
    const cats = [...new Set(an.findings.map((f) => f.category))];
    let list = an.findings;
    if (S.ui.cat !== 'all') list = list.filter((f) => f.category === S.ui.cat);
    if (!readOnly && S.ui.status === 'open') list = list.filter((f) => !doc.decisions[f.key]);
    if (!readOnly && S.ui.status === 'decided') list = list.filter((f) => doc.decisions[f.key]);
    const sum = BG.summarize(an.findings);
    let right = '<div class="summary"><span class="pill high">' + sum.high + ' high</span><span class="pill medium">' + sum.medium + ' medium</span><span class="pill low">' + sum.low + ' low</span>' +
      (!readOnly ? '<span class="muted">' + st.decided + ' of ' + st.findings.length + ' decided</span>' : '') + '</div>' +
      '<div class="filters" role="group" aria-label="Filter findings">' + [['all', 'All']].concat(cats.map((c) => [c, CAT[c]])).map((c) => '<button class="chip" aria-pressed="' + (S.ui.cat === c[0]) + '" data-a="cat" data-v="' + c[0] + '">' + c[1] + '</button>').join('') +
      (!readOnly ? ' <span style="width:8px"></span>' + [['all', 'Any status'], ['open', 'Open'], ['decided', 'Decided']].map((c) => '<button class="chip" aria-pressed="' + (S.ui.status === c[0]) + '" data-a="stat" data-v="' + c[0] + '">' + c[1] + '</button>').join('') : '') + '</div>';
    right += '<div class="list">' + (list.length ? list.map((f) => findingCard(f, doc, shown, editable)).join('') : '<div class="card empty">' + (an.findings.length ? 'No findings match this filter.' : 'No issues found. Everything checked passes the approved sources.') + '</div>') + '</div>';
    if (an.verified.length) right += '<details class="card pad"><summary>Checked and passing (' + an.verified.length + ')</summary><div class="list" style="margin-top:8px">' +
      an.verified.map((v) => '<div class="source"><b>' + E(v.guidelineId) + '</b> “' + E(v.excerpt) + '”: ' + E(v.note) + '</div>').join('') + '</div></details>';

    // workflow panel
    let wf = '';
    if (!readOnly) {
      if (editable) {
        const reasons = [];
        if (st.open) reasons.push(st.open + ' finding' + (st.open > 1 ? 's' : '') + ' still open');
        if (st.pendingApply) reasons.push(st.pendingApply + ' accepted change' + (st.pendingApply > 1 ? 's' : '') + ' not yet applied');
        if (st.highUnfixed) reasons.push(st.highUnfixed + ' high-severity finding' + (st.highUnfixed > 1 ? 's' : '') + ' marked “I will fix this” but still present: fix ' + (st.highUnfixed > 1 ? 'them' : 'it') + ' with Edit copy, or dismiss with a reason');
        wf = '<div class="card pad stack"><div class="h-row"><h3 style="font-size:15px">Send for approval</h3><span class="pill ' + stCls + '">' + stLabel + '</span></div>' +
          (reasons.length ? '<div class="muted">Before you submit: ' + reasons.join(', ') + '.</div>' : '<div class="muted">Every finding has a decision. A reviewer will see your dismissals and reasons.</div>') +
          '<div class="row">' + (st.pendingApply ? '<button class="btn primary" data-a="apply">Apply ' + st.pendingApply + ' accepted change' + (st.pendingApply > 1 ? 's' : '') + ' as version ' + (cur.n + 1) + '</button>' : '') +
          '<button class="btn ' + (st.pendingApply ? '' : 'primary') + '" data-a="submit"' + (reasons.length ? ' disabled' : '') + '>' + (doc.status === 'changes_requested' ? 'Resubmit for review' : 'Submit for review') + '</button></div></div>';
      } else if (doc.status === 'in_review' && role !== 'creator') {
        const allAck = st.highDismissed.every((f) => S.ui.ack[f.key]);
        wf = '<div class="card pad stack"><div class="h-row"><h3 style="font-size:15px">Your decision as ' + E(ROLES[role].label.toLowerCase()) + '</h3><span class="pill ' + stCls + '">' + stLabel + '</span></div>' +
          (st.highDismissed.length ? '<div class="callout"><b>' + st.highDismissed.length + ' high-severity finding' + (st.highDismissed.length > 1 ? 's need' : ' needs') + ' your sign-off.</b> They were dismissed, or marked “I will fix this” but are still in this version. Confirm you accept each one before approving.' +
            st.highDismissed.map((f) => { const dd = doc.decisions[f.key] || {}; return '<div class="row" style="margin-top:6px"><input type="checkbox" id="ack-' + E(f.key) + '" data-ack="' + E(f.key) + '"' + (S.ui.ack[f.key] ? ' checked' : '') + '><label for="ack-' + E(f.key) + '"><span class="mono">' + E(f.excerpt) + '</span> · ' + (dd.status === 'dismissed' ? 'dismissed: ' + E(dd.reason || '') + (dd.note ? ' (' + E(dd.note) + ')' : '') : 'marked “I will fix this”, still present') + '</label></div>'; }).join('') + '</div>' : '<div class="muted">No high-severity findings need sign-off. ' + st.decided + ' findings were decided by the creator.</div>') +
          '<div class="field"><label for="rc">Feedback (required to request changes)</label><textarea id="rc" data-ui="rc" rows="2">' + E(S.ui.rc) + '</textarea></div>' +
          '<div class="row"><button class="btn ok" data-a="approve"' + (allAck ? '' : ' disabled') + '>Approve version ' + cur.n + '</button><button class="btn" data-a="requestChanges">Request changes</button></div></div>';
      } else if (doc.status === 'in_review') {
        wf = '<div class="card pad"><span class="pill accent">In review</span> <span class="muted">Waiting for a reviewer or brand manager. You can still comment below.</span></div>';
      } else if (doc.status === 'approved') {
        wf = '<div class="card pad stack"><div class="h-row"><h3 style="font-size:15px">Approved for publication</h3><span class="pill ok">Approved</span></div><div class="muted">Version ' + doc.approval.version + ' approved by ' + E(doc.approval.by) + ', ' + fmt(doc.approval.at) + '.</div>' +
          '<div class="row"><button class="btn primary" data-a="copyFinal">Copy approved text</button>' + (role !== 'reviewer' ? '<button class="btn" data-a="revision">Start a new revision</button>' : '') + '</div></div>';
      } else if (role === 'reviewer') {
        wf = '<div class="card pad muted">The creator is still working on this draft. Reviewers act once it is submitted.</div>';
      }
    }

    // bottom: activity & versions
    const thread = doc.events.slice().sort((a, b) => a.at - b.at).map((e) => e.type === 'comment'
      ? '<div class="msg"><div class="meta">' + E(e.by) + ' · ' + E(ROLES[e.role] ? ROLES[e.role].label : '') + ' · ' + fmt(e.at) + '</div>' + E(e.text) + '</div>'
      : '<div class="msg event">' + fmt(e.at) + ' · ' + E(e.by) + ' ' + E(e.text) + '</div>').join('');
    const vers = doc.versions.slice().reverse().map((v) => {
      const a = analyzeDoc(doc, v);
      const s = BG.summarize(a.findings);
      return '<tr><td>v' + v.n + (v === cur ? ' <span class="pill accent">current</span>' : '') + '</td><td>' + E(v.note) + '</td><td>' + E(v.by) + '<br><span class="muted">' + fmt(v.at) + '</span></td><td class="mono">' + s.total + ' findings (' + s.high + ' high)</td><td>' +
        (v === shown ? '<span class="muted">Viewing</span>' : '<button class="btn sm" data-a="viewVer" data-n="' + v.n + '">View</button>') + '</td></tr>';
    }).join('');
    const bottom = '<section class="card pad" style="margin-top:16px"><div class="tabs2" role="group" aria-label="Document history"><button data-a="tab" data-v="activity" aria-pressed="' + (S.ui.tab === 'activity') + '">Comments and activity</button><button data-a="tab" data-v="versions" aria-pressed="' + (S.ui.tab === 'versions') + '">Versions (' + doc.versions.length + ')</button></div>' +
      (S.ui.tab === 'versions' ? '<div class="tablewrap"><table><thead><tr><th>Version</th><th>Change</th><th>By</th><th>Result</th><th></th></tr></thead><tbody>' + vers + '</tbody></table></div>'
        : '<div class="thread">' + (thread || '<div class="muted">No activity yet.</div>') + '</div><div class="row" style="margin-top:10px"><label class="sr" for="cm">Comment</label><input type="text" id="cm" data-ui="comment" style="flex:1 1 220px" placeholder="Add a comment" value="' + E(S.ui.comment) + '"><button class="btn" data-a="comment">Post comment</button></div>') + '</section>';

    return '<div class="doc-head"><div class="h-row"><h1>' + E(doc.title) + '</h1><span class="pill ' + stCls + '">' + stLabel + '</span></div>' + owner + '</div>' +
      '<div class="grid2"><section class="sticky-col" aria-label="Copy under review">' + left + '</section><section class="stack" aria-label="Findings">' + wf + right + '</section></div>' + bottom;
  }

  function viewQueue() {
    const f = S.ui.docFilter;
    let docs = S.docs.slice().sort((a, b) => curVer(b).at - curVer(a).at);
    if (f !== 'all') docs = docs.filter((d) => d.status === f);
    const rows = docs.map((d) => {
      const st = stats(d);
      const [l, c] = STATUS[d.status];
      return '<tr class="click" tabindex="0" data-a="openDoc" data-id="' + d.id + '"><td><b>' + E(d.title) + '</b>' + (d.sample ? ' <span class="pill neutral">sample</span>' : '') + '<br><span class="muted">' + E(d.channel) + '</span></td><td>' + E(d.ownerName) + '</td><td><span class="pill ' + c + '">' + l + '</span></td><td class="mono">v' + curVer(d).n + '</td><td class="mono">' + st.open + ' open · ' + st.high + ' high</td><td class="muted">' + fmt(curVer(d).at) + '</td></tr>';
    }).join('');
    const waiting = S.docs.filter((d) => d.status === 'in_review').length;
    return '<div class="h-row" style="margin-bottom:12px"><h1 style="font-size:22px">Review queue</h1><div class="filters">' +
      [['all', 'All'], ['in_review', 'In review'], ['changes_requested', 'Changes requested'], ['draft', 'Draft'], ['approved', 'Approved']].map((c) => '<button class="chip" aria-pressed="' + (f === c[0]) + '" data-a="docFilter" data-v="' + c[0] + '">' + c[1] + '</button>').join('') + '</div></div>' +
      (S.role !== 'creator' && waiting ? '<div class="notice" style="margin-bottom:12px">' + waiting + ' document' + (waiting > 1 ? 's are' : ' is') + ' waiting for your review.</div>' : '') +
      '<div class="card tablewrap"><table><thead><tr><th>Document</th><th>Owner</th><th>Status</th><th>Version</th><th>Findings</th><th>Updated</th></tr></thead><tbody>' + (rows || '<tr><td colspan="6" class="empty">Nothing here.</td></tr>') + '</tbody></table></div>';
  }

  function viewKit() {
    const k = S.kit;
    const mgr = S.role === 'manager';
    const dis = mgr ? '' : ' disabled';
    return '<div class="stack"><div class="h-row"><div><h1 style="font-size:22px">Brand kit</h1><div class="muted">The only sources a review may cite. Version ' + E(k.version) + (mgr ? '' : ' · read-only for your role') + '</div></div></div>' +
      (mgr ? '<div class="notice">Changes apply immediately: every open review is re-checked against the updated kit.</div>' : '<div class="notice">Only the brand manager can change the kit. Switch to Arjun Mehta (Brand manager) to edit.</div>') +
      '<section class="card pad stack"><h2 style="font-size:16px">Guidelines</h2><div class="list">' + k.guidelines.map((g) => '<div><span class="mono"><b>' + E(g.id) + '</b></span> <b>' + E(g.section) + '</b> · ' + E(g.title) + '<div class="muted">' + E(g.text) + '</div></div>').join('') + '</div></section>' +
      '<section class="card pad stack"><h2 style="font-size:16px">Terminology</h2><div class="tablewrap"><table><thead><tr><th>ID</th><th>Use</th><th>Instead of</th><th>Guideline</th></tr></thead><tbody>' +
      k.terms.map((t) => '<tr><td class="mono">' + E(t.id) + '</td><td><b>' + E(t.preferred) + '</b></td><td>' + t.avoid.map(E).join(', ') + '</td><td class="mono">' + E(t.guideline) + '</td></tr>').join('') + '</tbody></table></div>' +
      '<div class="fields"><div class="field"><label for="tp">Preferred term</label><input type="text" id="tp"' + dis + '></div><div class="field"><label for="ta">Avoid (comma separated)</label><input type="text" id="ta"' + dis + '></div>' +
      '<div class="field"><label for="tg">Guideline</label><select id="tg"' + dis + '>' + k.guidelines.map((g) => '<option>' + E(g.id) + '</option>').join('') + '</select></div></div><div><button class="btn" data-a="addTerm"' + dis + '>Add term</button></div></section>' +
      '<section class="card pad stack"><h2 style="font-size:16px">Approved facts</h2><div class="tablewrap"><table><thead><tr><th>ID</th><th>Name</th><th>Price (₹)</th><th>Validity (days)</th><th>Status</th><th>Source</th></tr></thead><tbody>' +
      k.facts.map((f) => '<tr><td class="mono">' + E(f.id) + '</td><td>' + E(f.name) + '</td><td>' + (f.status === 'retired' ? '—' : '<input type="number" aria-label="Price of ' + E(f.name) + '" style="width:90px" data-kit="fact" data-id="' + E(f.id) + '" data-field="price" value="' + f.price + '"' + dis + '>') + '</td><td>' +
        (f.status === 'retired' ? '—' : '<input type="number" aria-label="Validity of ' + E(f.name) + '" style="width:80px" data-kit="fact" data-id="' + E(f.id) + '" data-field="validityDays" value="' + f.validityDays + '"' + dis + '>') + '</td><td><span class="pill ' + (f.status === 'retired' ? 'neutral' : 'ok') + '">' + E(f.status) + '</span></td><td class="muted">' + E(f.source) + '</td></tr>').join('') + '</tbody></table></div></section>' +
      '<section class="card pad stack"><h2 style="font-size:16px">Claim evidence</h2><div class="tablewrap"><table><thead><tr><th>ID</th><th>Topic</th><th>Scope</th><th>Source</th><th>Status</th><th>Valid to</th></tr></thead><tbody>' +
      k.evidence.map((e) => '<tr><td class="mono">' + E(e.id) + '</td><td>' + E(e.topic) + '</td><td>' + E(e.scope) + '</td><td>' + E(e.source) + '</td><td><select aria-label="Status of ' + E(e.id) + '" data-kit="ev" data-id="' + E(e.id) + '" data-field="status"' + dis + '>' + ['approved', 'withdrawn'].map((s) => '<option' + (e.status === s ? ' selected' : '') + '>' + s + '</option>').join('') + '</select></td><td><input type="date" aria-label="Valid to for ' + E(e.id) + '" data-kit="ev" data-id="' + E(e.id) + '" data-field="expires" value="' + E(e.expires) + '"' + dis + '></td></tr>').join('') + '</tbody></table></div></section>' +
      '<section class="card pad stack"><h2 style="font-size:16px">Visual assets</h2><div>' + k.visual.palette.map((p) => '<span class="swatch-lg"><i style="background:' + E(p.hex) + '"></i>' + E(p.name) + ' <span class="mono muted">' + E(p.hex) + '</span></span>').join('') + '</div>' +
      '<div class="muted">Fonts: ' + k.visual.fonts.map(E).join(', ') + ' · Logo minimum ' + k.visual.logo.minWidth + 'px wide, ratio ' + k.visual.logo.aspect + ':1 · Minimum contrast ' + k.visual.minContrast + ':1</div></section>' +
      '<section class="card pad stack"><h2 style="font-size:16px">Import or export the kit</h2><div class="muted">Paste a kit as JSON to replace this one, or copy the current kit to reuse it.</div>' +
      '<textarea id="kitjson" rows="6" class="mono" style="width:100%" aria-label="Kit JSON"' + dis + '>' + E(JSON.stringify(k, null, 2)) + '</textarea><div class="row"><button class="btn" data-a="importKit"' + dis + '>Apply pasted kit</button><button class="btn" data-a="copyKit">Copy kit JSON</button><button class="btn" data-a="resetKit"' + dis + '>Restore sample kit</button></div></section></div>';
  }

  /* ---------------- insights ---------------- */
  function records(doc) {
    const out = doc.resolved.map((r) => Object.assign({}, r, { doc: doc.id }));
    const st = stats(doc);
    for (const f of st.findings) {
      const d = doc.decisions[f.key];
      out.push(Object.assign(meta(f), { key: f.key, outcome: d ? d.status : 'open', reason: d ? d.reason : '', doc: doc.id }));
    }
    return out;
  }
  function ruleKey(r) { return r.rule === 'terminology' ? 'terminology:' + r.refId : r.rule; }
  function ruleName(r) {
    if (r.rule === 'terminology') { const t = S.kit.terms.find((x) => x.id === r.refId); return t ? 'Say “' + t.preferred + '”, not “' + t.avoid[0] + '”' : 'Terminology'; }
    return RULE_LABEL[r.rule] || r.rule;
  }

  function viewInsights() {
    const all = [];
    S.docs.forEach((d) => all.push.apply(all, records(d)));
    const acted = (o) => o === 'accepted' || o === 'edited' || o === 'fixed';
    const n = all.length;
    const acc = all.filter((r) => acted(r.outcome)).length, dis = all.filter((r) => r.outcome === 'dismissed').length, open = all.filter((r) => r.outcome === 'open').length;
    const byRule = new Map();
    all.forEach((r) => { const k = ruleKey(r); const o = byRule.get(k) || { name: ruleName(r), n: 0, docs: new Set(), a: 0, d: 0, o: 0 }; o.n++; o.docs.add(r.doc); if (acted(r.outcome)) o.a++; else if (r.outcome === 'dismissed') o.d++; else o.o++; byRule.set(k, o); });
    const top = [...byRule.values()].sort((a, b) => b.n - a.n).slice(0, 8);
    const maxTop = Math.max(1, top[0] ? top[0].n : 1);
    const byG = new Map();
    all.forEach((r) => { const o = byG.get(r.guidelineId) || { id: r.guidelineId, n: 0, a: 0, d: 0, o: 0, unclear: 0 }; o.n++; if (acted(r.outcome)) o.a++; else if (r.outcome === 'dismissed') { o.d++; if (r.reason === 'Guideline unclear') o.unclear++; } else o.o++; byG.set(r.guidelineId, o); });
    const gl = [...byG.values()].sort((a, b) => b.d - a.d || b.n - a.n);
    const unclear = gl.filter((g) => (g.n >= 3 && g.d / g.n >= 0.5) || g.unclear >= 2);
    const cats = {}; all.forEach((r) => { cats[r.category] = (cats[r.category] || 0) + 1; });
    const catMax = Math.max(1, ...Object.values(cats));
    const first = S.docs.map((d) => ({ d, a: analyzeDoc(d, d.versions[0]).findings.length, b: analyzeDoc(d, curVer(d)).findings.length })).filter((x) => x.a > 0);
    const gtitle = (id) => { const g = S.kit.guidelines.find((x) => x.id === id); return g ? g.section : id; };
    return '<div class="stack"><div><h1 style="font-size:22px">Governance insights</h1><div class="muted">Built from every review in this workspace, including the sample history.</div></div>' +
      '<div class="kpis"><div class="card kpi"><span class="muted">Reviews</span><b>' + S.docs.length + '</b></div><div class="card kpi"><span class="muted">Findings raised</span><b>' + n + '</b></div>' +
      '<div class="card kpi"><span class="muted">Acted on</span><b>' + (n ? Math.round(acc / n * 100) : 0) + '%</b></div><div class="card kpi"><span class="muted">Dismissed</span><b>' + (n ? Math.round(dis / n * 100) : 0) + '%</b></div><div class="card kpi"><span class="muted">Still open</span><b>' + open + '</b></div></div>' +
      (unclear.length ? '<div class="callout"><b>Guidelines that may be unclear</b>' + unclear.map((g) => '<div style="margin-top:6px"><b class="mono">' + E(g.id)+ '</b> ' + E(gtitle(g.id)) + ': creators dismissed ' + g.d + ' of ' + g.n + ' flags' + (g.unclear ? ', ' + g.unclear + ' as “Guideline unclear”' : '') + '. Review the wording of this rule with the brand team: add an example, an exception, or a different limit.</div>').join('') + '</div>' : '') +
      '<div class="grid2"><section class="card pad"><h2 style="font-size:16px">Most repeated mistakes</h2><div class="legend" style="margin:6px 0"><span><i class="seg-a"></i>Fixed</span><span><i class="seg-d"></i>Dismissed</span><span><i class="seg-o"></i>Open</span></div>' +
      top.map((t) => '<div class="bar"><span class="lbl">' + E(t.name) + '<span class="muted"> · ' + t.docs.size + ' doc' + (t.docs.size > 1 ? 's' : '') + '</span></span><span class="track" style="width:' + Math.round(t.n / maxTop * 100) + '%"><i class="seg-a" style="width:' + t.a / t.n * 100 + '%"></i><i class="seg-d" style="width:' + t.d / t.n * 100 + '%"></i><i class="seg-o" style="width:' + t.o / t.n * 100 + '%"></i></span><span class="num">' + t.n + '</span></div>').join('') + '</section>' +
      '<section class="card pad"><h2 style="font-size:16px">Guideline health</h2><div class="muted" style="margin:2px 0 6px">Share of flags creators dismissed, by guideline</div>' +
      gl.map((g) => '<div class="bar"><span class="lbl"><span class="mono">' + E(g.id) + '</span> ' + E(gtitle(g.id)) + '</span><span class="track"><i class="seg-d" style="width:' + g.d / g.n * 100 + '%"></i><i class="seg-a" style="width:' + g.a / g.n * 100 + '%"></i></span><span class="num">' + Math.round(g.d / g.n * 100) + '%</span></div>').join('') + '</section></div>' +
      '<div class="grid2"><section class="card pad"><h2 style="font-size:16px">Findings by category</h2>' + Object.keys(cats).sort((a, b) => cats[b] - cats[a]).map((c) => '<div class="bar"><span class="lbl">' + CAT[c] + '</span><span class="track" style="width:' + Math.round(cats[c] / catMax * 100) + '%"><i class="seg-f" style="width:100%"></i></span><span class="num">' + cats[c] + '</span></div>').join('') + '</section>' +
      '<section class="card pad"><h2 style="font-size:16px">First draft vs latest version</h2><div class="legend" style="margin:6px 0"><span><i class="seg-d"></i>First draft</span><span><i class="seg-a"></i>Latest</span></div>' +
      first.map((x) => { const m = Math.max(x.a, x.b, 1); return '<div class="bar"><span class="lbl">' + E(x.d.title) + '</span><span class="track" style="flex-direction:column;height:22px;gap:2px;background:none"><i class="seg-d" style="height:10px;border-radius:3px;width:' + x.a / Math.max(...first.map((y) => y.a)) * 100 + '%"></i><i class="seg-a" style="height:10px;border-radius:3px;width:' + x.b / Math.max(...first.map((y) => y.a)) * 100 + '%"></i></span><span class="num">' + x.a + '→' + x.b + '</span></div>'; }).join('') + '</section></div></div>';
  }

  function viewAbout() {
    return '<div class="stack" style="max-width:820px"><h1 style="font-size:22px">AI use, privacy and limits</h1>' +
      '<section class="card pad stack"><h2 style="font-size:16px">How a check works</h2><p style="margin:0">Each finding comes from a rule that points at an item in your Brand kit: a guideline, an approved term, a plan-sheet fact or an evidence entry. Matching is by explicit patterns, not by a language model, so the same input always gives the same result and every result can be traced.</p></section>' +
      '<section class="card pad stack"><h2 style="font-size:16px">AI and external services</h2><p style="margin:0"><b>No AI model and no external service processes your content in this version.</b> Text, Word and PDF reading, images and colour sampling all run on your device, and this page makes no network requests after it loads. The libraries it bundles are JSZip (Word files) and pdf.js (PDF files). Development disclosure: this prototype was built with AI coding assistance (Claude). A future version may add a language model for tone and paraphrased claims; if it does, this page will name the model and the data sent, and it will stay switchable by an administrator.</p></section>' +
      '<section class="card pad stack"><h2 style="font-size:16px">Human control</h2><p style="margin:0">Nothing is changed automatically. Every suggestion needs an accept, edit or dismiss. Dismissals need a reason. A reviewer must confirm each dismissed high-severity finding before approving. Every decision, comment, version and approval is recorded in the document history.</p></section>' +
      '<section class="card pad stack"><h2 style="font-size:16px">Privacy</h2><p style="margin:0">Documents, decisions and the kit are stored in this browser only. Clearing site data removes them. There are no accounts: the three people in the sign-in menu are demo roles that show how permissions work. A production version would add real sign-in, per-organisation storage and encryption.</p></section>' +
      '<section class="card pad stack"><h2 style="font-size:16px">Known limits</h2><ul style="margin:0;padding-left:18px"><li>Images are checked from their metadata, dominant colours and the details you enter, not by reading the picture. Text inside an image is not read.</li><li>PDF import reads the text layer only. A scanned PDF has no text to read, so paste the text instead.</li><li>Tone is judged by word lists and sentence length, so subtle tone problems are missed.</li><li>A claim is matched by its wording; a differently worded claim is not caught.</li><li>The sample kit and sample reviews are invented for the demo.</li></ul></section></div>';
  }

  /* ---------------- render ---------------- */
  function render(keepScroll) {
    const y = window.scrollY;
    const body = { new: viewNew, review: viewReview, queue: viewQueue, kit: viewKit, insights: viewInsights, about: viewAbout }[S.view]();
    document.getElementById('app').innerHTML = shell(body);
    if (keepScroll) window.scrollTo(0, y);
  }
  function toast(msg) { S.toast = msg; render(true); clearTimeout(toast.t); toast.t = setTimeout(() => { S.toast = ''; render(true); }, 2600); }

  /* ---------------- actions ---------------- */
  const canDecide = (doc) => ['draft', 'changes_requested'].includes(doc.status) && S.role !== 'reviewer';
  const findingByKey = (doc, key) => stats(doc).findings.find((f) => f.key === key);

  function decide(doc, f, d, verb) {
    doc.decisions[f.key] = Object.assign(meta(f), d, { by: S.role, at: Date.now() });
    log(doc, verb + ' “' + (f.excerpt.length > 40 ? f.excerpt.slice(0, 37) + '...' : f.excerpt) + '” (' + CAT[f.category].toLowerCase() + ')');
  }

  const A = {
    nav(a) { S.view = a.view; S.ui.selected = null; render(); window.scrollTo(0, 0); },
    sample(a) { S.draft = sampleDraft(Number(a.i)); render(true); },
    removeImg(a) { S.draft.images.splice(Number(a.i), 1); render(true); },
    run() {
      const d = S.draft;
      if (!d.text.trim()) return toast('Paste or import some copy first.');
      const doc = { id: uid(), sample: false, title: d.title.trim() || 'Untitled draft', channel: d.channel, ownerRole: S.role, ownerName: user(), created: Date.now(), status: 'draft',
        versions: [{ n: 1, text: d.text, images: clone(d.images), at: Date.now(), by: user(), note: 'First submission' }], decisions: {}, resolved: [], events: [], approval: null };
      log(doc, 'submitted the first draft for checking');
      S.docs.push(doc); S.currentId = doc.id; S.view = 'review'; S.draft = blankDraft(); S.ui.selected = null; S.ui.cat = 'all'; S.ui.status = 'all'; S.ui.viewVer = null; S.ui.editText = false; S.ui.ack = {};
      save(); render(); window.scrollTo(0, 0);
    },
    openDoc(a) { S.currentId = a.id; S.view = 'review'; S.ui.selected = null; S.ui.viewVer = null; S.ui.editText = false; S.ui.cat = 'all'; S.ui.status = 'all'; S.ui.ack = {}; S.ui.rc = ''; render(); window.scrollTo(0, 0); },
    select(a) {
      S.ui.selected = a.key; S.ui.cat = 'all'; S.ui.status = 'all'; render(true);
      const el = document.getElementById('f-' + (window.CSS && CSS.escape ? CSS.escape(a.key) : a.key));
      if (el) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    },
    cat(a) { S.ui.cat = a.v; render(true); },
    stat(a) { S.ui.status = a.v; render(true); },
    docFilter(a) { S.ui.docFilter = a.v; render(true); },
    tab(a) { S.ui.tab = a.v; render(true); },
    viewVer(a) { S.ui.viewVer = a.n ? Number(a.n) : null; render(true); },
    accept(a) {
      const doc = curDoc(); const f = findingByKey(doc, a.key); if (!doc || !f || !canDecide(doc)) return;
      decide(doc, f, { status: 'accepted' }, f.suggestion ? 'accepted the suggestion for' : 'acknowledged'); save(); render(true);
    },
    editStart(a) { S.ui.editing = a.key; S.ui.dismissing = null; render(true); },
    dismissStart(a) { S.ui.dismissing = a.key; S.ui.editing = null; render(true); },
    cancelUi() { S.ui.editing = null; S.ui.dismissing = null; render(true); },
    editSave(a) {
      const doc = curDoc(); const f = findingByKey(doc, a.key);
      const v = document.querySelector('[data-role="edit"]').value;
      if (!f || !canDecide(doc)) return;
      if (!v.trim() && !(f.target)) return toast('Type the wording to use, or cancel.');
      if (f.target && !v.trim()) return toast('Alt text cannot be empty.');
      S.ui.editing = null; decide(doc, f, { status: 'edited', replacement: v }, 'edited the suggestion for'); save(); render(true);
    },
    dismissSave(a) {
      const doc = curDoc(); const f = findingByKey(doc, a.key);
      const reason = document.querySelector('[data-role="reason"]').value; const note = document.querySelector('[data-role="note"]').value.trim();
      if (!f || !canDecide(doc)) return;
      if (reason === 'Other' && !note) return toast('Add a short note when the reason is “Other”.');
      S.ui.dismissing = null; decide(doc, f, { status: 'dismissed', reason, note }, 'dismissed'); save(); render(true);
    },
    undo(a) { const doc = curDoc(); if (!doc || !canDecide(doc)) return; delete doc.decisions[a.key]; log(doc, 'reopened a finding'); save(); render(true); },
    apply() {
      const doc = curDoc(); if (!doc || !canDecide(doc)) return;
      const n = applyAccepted(doc); S.ui.selected = null; save(); render(true);
      toast(n ? 'Version ' + curVer(doc).n + ' created with ' + n + ' change' + (n > 1 ? 's' : '') + '. Remaining findings were re-checked.' : 'Nothing to apply.');
    },
    editText() { S.ui.editText = true; render(true); },
    cancelText() { S.ui.editText = false; render(true); },
    saveText() {
      const doc = curDoc(); const v = document.getElementById('etext').value;
      if (!doc || !canDecide(doc)) return;
      if (v === curVer(doc).text) { S.ui.editText = false; return render(true); }
      const n = rollVersion(doc, v, clone(curVer(doc).images || []), 'Edited by hand');
      log(doc, 'edited the copy (version ' + n + ')'); S.ui.editText = false; save(); render(true); toast('Saved as version ' + n + ' and re-checked.');
    },
    submit() {
      const doc = curDoc(); const st = stats(doc);
      if (!canDecide(doc) || st.open || st.pendingApply || st.highUnfixed) return;
      doc.status = 'in_review'; log(doc, 'submitted version ' + curVer(doc).n + ' for review'); S.ui.ack = {}; save(); render(true); toast('Submitted. A reviewer can now approve or request changes.');
    },
    approve() {
      const doc = curDoc(); const st = stats(doc);
      if (doc.status !== 'in_review' || S.role === 'creator') return;
      if (!st.highDismissed.every((f) => S.ui.ack[f.key])) return toast('Confirm each high-severity dismissal first.');
      doc.status = 'approved'; doc.approval = { by: user(), at: Date.now(), version: curVer(doc).n, acknowledged: st.highDismissed.map((f) => f.key) };
      log(doc, 'approved version ' + curVer(doc).n + (st.highDismissed.length ? ' and signed off ' + st.highDismissed.length + ' high-severity finding(s)' : '')); save(); render(true); toast('Approved. The text is ready for publication.');
    },
    requestChanges() {
      const doc = curDoc(); const txt = (S.ui.rc || '').trim();
      if (doc.status !== 'in_review' || S.role === 'creator') return;
      if (!txt) return toast('Write what needs to change first.');
      doc.status = 'changes_requested'; log(doc, 'Changes requested: ' + txt, 'comment'); S.ui.rc = ''; save(); render(true); toast('Sent back to the creator.');
    },
    comment() {
      const doc = curDoc(); const t = (S.ui.comment || '').trim(); if (!t) return;
      log(doc, t, 'comment'); S.ui.comment = ''; save(); render(true);
    },
    revision() {
      const doc = curDoc(); if (doc.status !== 'approved' || S.role === 'reviewer') return;
      const cur = curVer(doc); doc.versions.push({ n: cur.n + 1, text: cur.text, images: clone(cur.images || []), at: Date.now(), by: user(), note: 'New revision of approved copy' });
      doc.status = 'draft'; doc.approval = null; log(doc, 'started a new revision (version ' + (cur.n + 1) + ')'); save(); render(true);
    },
    copyFinal() {
      const doc = curDoc(); const txt = curVer(doc).text;
      const done = () => toast('Approved text copied.');
      try { navigator.clipboard.writeText(txt).then(done, () => { selectPaper(); toast('Copy blocked here. The text is selected: press Ctrl+C.'); }); } catch (e) { selectPaper(); toast('Copy blocked here. The text is selected: press Ctrl+C.'); }
    },
    addTerm() {
      if (S.role !== 'manager') return;
      const p = document.getElementById('tp').value.trim(); const av = document.getElementById('ta').value.split(',').map((s) => s.trim()).filter(Boolean); const g = document.getElementById('tg').value;
      if (!p || !av.length) return toast('Enter the preferred term and at least one term to avoid.');
      S.kit.terms.push({ id: 'T-' + (S.kit.terms.length + 1), preferred: p, avoid: av, guideline: g, note: '' }); kitChanged('Term added.');
    },
    importKit() {
      if (S.role !== 'manager') return;
      try {
        const k = JSON.parse(document.getElementById('kitjson').value);
        if (!Array.isArray(k.guidelines) || !Array.isArray(k.terms) || !Array.isArray(k.facts) || !Array.isArray(k.evidence) || !Array.isArray(k.claimRules) || !k.visual || !k.tone) throw new Error('A kit needs guidelines, terms, facts, evidence, claimRules, tone and visual.');
        S.kit = k; kitChanged('Kit imported.');
      } catch (e) { toast('Could not import: ' + e.message); }
    },
    copyKit() { const el = document.getElementById('kitjson'); try { navigator.clipboard.writeText(el.value).then(() => toast('Kit JSON copied.'), () => { el.select(); toast('Copy blocked here. The kit is selected: press Ctrl+C.'); }); } catch (e) { el.select(); } },
    resetKit() { if (S.role !== 'manager') return; S.kit = clone(BG.sampleKit); kitChanged('Sample kit restored.'); },
    resetDemo() { try { localStorage.removeItem(KEY); } catch (e) { /* ignore */ } memo.clear(); S = null; init(); S.view = 'new'; render(); window.scrollTo(0, 0); toast('Demo data reset.'); }
  };

  function selectPaper() { const p = document.getElementById('paper'); if (p && window.getSelection) { const r = document.createRange(); r.selectNodeContents(p); const s = window.getSelection(); s.removeAllRanges(); s.addRange(r); } }
  function kitChanged(msg) { kitStamp++; memo.clear(); save(); render(true); toast(msg + ' Open reviews were re-checked.'); }

  document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-a]');
    if (!el || el.disabled) return;
    if (el.tagName === 'LABEL') return;
    const fn = A[el.dataset.a]; if (fn) fn(el.dataset, e);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const el = e.target.closest('.hl[data-a], tr.click[data-a]');
    if (el) { e.preventDefault(); A[el.dataset.a](el.dataset); }
  });
  document.addEventListener('input', (e) => {
    const t = e.target;
    if (t.dataset.draft) S.draft[t.dataset.draft] = t.value;
    else if (t.dataset.img != null && t.dataset.f) { S.draft.images[Number(t.dataset.img)][t.dataset.f] = t.value; }
    else if (t.dataset.ui) S.ui[t.dataset.ui] = t.value;
  });
  document.addEventListener('change', async (e) => {
    const t = e.target;
    if (t.dataset.change === 'role') { S.role = t.value; S.ui.dismissing = null; S.ui.editing = null; S.ui.editText = false; render(true); return; }
    if (t.dataset.ack) { S.ui.ack[t.dataset.ack] = t.checked; render(true); return; }
    if (t.dataset.img != null && t.dataset.f) { S.draft.images[Number(t.dataset.img)][t.dataset.f] = t.value; return; }
    if (t.dataset.draft === 'channel') { S.draft.channel = t.value; return; }
    if (t.dataset.kit && S.role === 'manager') {
      if (t.dataset.kit === 'fact') { const f = S.kit.facts.find((x) => x.id === t.dataset.id); const v = Number(t.value); if (f && v > 0) { f[t.dataset.field] = v; kitChanged(f.name + ' updated in the approved facts.'); } }
      if (t.dataset.kit === 'ev') { const x = S.kit.evidence.find((y) => y.id === t.dataset.id); if (x) { x[t.dataset.field] = t.value; kitChanged('Evidence ' + x.id + ' updated.'); } }
      return;
    }
    if (t.dataset.file) {
      const file = t.files && t.files[0]; if (!file) return;
      try {
        if (t.dataset.file === 'text') { S.draft.text = await readTextFile(file); if (!S.draft.title) S.draft.title = file.name.replace(/\.[^.]+$/, ''); render(true); toast('Imported ' + file.name); }
        else if (t.dataset.file === 'image') { S.draft.images.push(await processImage(file)); render(true); }
        else if (t.dataset.file === 'addimage') {
          const doc = curDoc(); if (!doc || !canDecide(doc)) return;
          const im = await processImage(file); const cur = curVer(doc);
          const n = rollVersion(doc, cur.text, clone(cur.images || []).concat([im]), 'Added image ' + file.name);
          log(doc, 'added image ' + file.name + ' (version ' + n + ')'); save(); render(true);
        }
      } catch (err) { toast(err.message); }
      t.value = '';
    }
  });

  window.__bg = { get state() { return S; }, actions: A, stats: () => (curDoc() ? stats(curDoc()) : null) };
  init();
  render();
})();
