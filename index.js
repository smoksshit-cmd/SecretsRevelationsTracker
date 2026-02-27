/**
 * Secrets & Revelations Tracker (SillyTavern Extension)
 * - Per-chat secrets storage (chatMetadata)
 * - Floating widget + side drawer editor
 * - Prompt injection using setExtensionPrompt() (no chat pollution)
 *
 * Docs: https://docs.sillytavern.app/for-contributors/writing-extensions/
 */

(() => {
  'use strict';

  const MODULE_KEY = 'secrets_revelations_tracker';
  const CHAT_KEY = 'srt_state_v1';
  const PROMPT_TAG = 'SRT_SECRETS_TRACKER';

  // These enums are exported by ST core, but we keep local fallbacks to avoid brittle imports.
  const EXT_PROMPT_TYPES = Object.freeze({
    NONE: -1,
    IN_PROMPT: 0,
    IN_CHAT: 1,
    BEFORE_PROMPT: 2,
  });

  const TAGS = Object.freeze({
    none: { label: '—', icon: '' },
    dangerous: { label: '💣 Опасные', icon: '💣' },
    personal: { label: '💔 Личные', icon: '💔' },
    kompromat: { label: '🗡️ Компромат', icon: '🗡️' },
  });

  const defaultSettings = Object.freeze({
    enabled: true,
    showWidget: true,
    // Where to place the injected tracker text:
    position: EXT_PROMPT_TYPES.IN_PROMPT,
    depth: 0,
  });

  function ctx() {
    return SillyTavern.getContext();
  }

  function getSettings() {
    const { extensionSettings, saveSettingsDebounced } = ctx();
    if (!extensionSettings[MODULE_KEY]) {
      extensionSettings[MODULE_KEY] = structuredClone(defaultSettings);
      saveSettingsDebounced();
    }
    // ensure new defaults exist after updates
    for (const k of Object.keys(defaultSettings)) {
      if (!Object.hasOwn(extensionSettings[MODULE_KEY], k)) {
        extensionSettings[MODULE_KEY][k] = defaultSettings[k];
      }
    }
    return extensionSettings[MODULE_KEY];
  }

  async function getChatState() {
    const { chatMetadata, saveMetadata } = ctx();
    if (!chatMetadata[CHAT_KEY]) {
      chatMetadata[CHAT_KEY] = {
        npcLabel: '{{char}}',
        npcSecrets: [],   // {id, text, tag, knownToUser}
        userSecrets: [],  // {id, text, tag, knownToNpc}
        mutualSecrets: [],// {id, text, tag}
      };
      await saveMetadata();
    }
    return chatMetadata[CHAT_KEY];
  }

  function makeId() {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
  }

  function escapeHtml(s) {
    return String(s)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;');
  }

  function getActiveNpcNameForUi() {
    const c = ctx();
    try {
      if (c.characterId !== undefined && c.characters?.[c.characterId]?.name) return c.characters[c.characterId].name;
      if (c.groupId !== undefined && c.groups?.find?.(g => g.id === c.groupId)?.name) return c.groups.find(g => g.id === c.groupId).name;
    } catch {}
    return 'NPC';
  }

  function formatList(lines) {
    if (!lines.length) return '[none]';
    return lines.map(x => `- ${x}`).join('\n');
  }

  function leverageScore(items) {
    // "Dirt" heuristic: kompromat & dangerous matter more, personal matters a bit.
    return items.reduce((sum, it) => {
      if (it.tag === 'kompromat') return sum + 2;
      if (it.tag === 'dangerous') return sum + 2;
      if (it.tag === 'personal') return sum + 1;
      return sum + 0;
    }, 0);
  }

  function buildPromptBlock(state) {
    const npcKnownToUser = state.npcSecrets.filter(s => !!s.knownToUser);
    const npcHiddenFromUser = state.npcSecrets.filter(s => !s.knownToUser);
    const userKnownToNpc = state.userSecrets.filter(s => !!s.knownToNpc);

    const revealed = npcKnownToUser.length + state.userSecrets.length + state.mutualSecrets.length;
    const hidden = npcHiddenFromUser.length;

    const userKnowsNpcLines = npcKnownToUser.map(s => `${s.text} ${TAGS[s.tag]?.icon ?? ''}`.trim());
    const npcKnowsUserLines = userKnownToNpc.map(s => `${s.text} ${TAGS[s.tag]?.icon ?? ''}`.trim());
    const mutualLines = state.mutualSecrets.map(s => `${s.text} ${TAGS[s.tag]?.icon ?? ''}`.trim());

    const npcLeverage = leverageScore(userKnownToNpc);
    const userLeverage = leverageScore(npcKnownToUser);

    let balance = 'Равный';
    if (npcLeverage > userLeverage) balance = 'NPC';
    if (userLeverage > npcLeverage) balance = '{{user}}';

    return [
`[SECRETS & REVELATIONS TRACKER]

Track secrets, hidden information, and discoveries between {{user}} and NPCs. Update when secrets are revealed, discovered, or used.

<SECRET CATEGORIES>
- 🔓 Раскрытые (Known to {{user}})
- 🔒 Скрытые (Hidden from {{user}})
- 💣 Опасные (Could cause major consequences)
- 💔 Личные (Emotional/vulnerable secrets)
- 🗡️ Компромат (Can be used as leverage)
</SECRET CATEGORIES>

<TRACKING>
- Total Secrets: [${hidden} hidden / ${revealed} revealed]
- {{user}}'s secrets known to NPC:
${formatList(npcKnowsUserLines)}
- NPC's secrets known to {{user}}:
${formatList(userKnowsNpcLines)}
- Mutual secrets (shared):
${formatList(mutualLines)}
- Leverage Balance: [${balance}]
</TRACKING>
`
    ].join('\n');
  }

  async function updateInjectedPrompt() {
    const settings = getSettings();
    const { setExtensionPrompt } = ctx();
    if (!settings.enabled) {
      setExtensionPrompt(PROMPT_TAG, '', EXT_PROMPT_TYPES.IN_PROMPT, 0, true);
      return;
    }
    const state = await getChatState();
    const block = buildPromptBlock(state);
    setExtensionPrompt(PROMPT_TAG, block, settings.position, settings.depth, true);
    // keep widget UI updated too
    await renderWidget();
  }

  // ---------------- UI (widget + drawer) ----------------

  function ensureFab() {
    if ($('#srt_fab').length) return;
    $('body').append(`
      <div id="srt_fab">
        <button type="button" id="srt_fab_btn" title="Secrets Tracker">
          🔐 <span class="srt-count" id="srt_fab_revealed">0</span> /
          <span class="srt-count-hidden" id="srt_fab_hidden">0</span>
        </button>
      </div>
    `);
    $('#srt_fab_btn').on('click', () => openDrawer(true));
  }

  function ensureDrawer() {
    if ($('#srt_drawer').length) return;

    $('body').append(`
      <aside id="srt_drawer" aria-hidden="true">
        <header>
          <div class="topline">
            <div class="title">🔐 СЕКРЕТЫ И ТАЙНЫ</div>
            <button id="srt_close" title="Close">✕</button>
          </div>
          <div class="sub" id="srt_subtitle"></div>
        </header>

        <div class="content" id="srt_content"></div>

        <div class="footer">
          <button id="srt_quick_export">Export</button>
          <button id="srt_quick_import">Import</button>
          <button id="srt_close2">Close</button>
        </div>
      </aside>
    `);

    $('#srt_close, #srt_close2').on('click', () => openDrawer(false));
    $('#srt_quick_export').on('click', () => exportJson());
    $('#srt_quick_import').on('click', () => importJson());
  }

  function openDrawer(open) {
    ensureDrawer();
    const el = $('#srt_drawer');
    if (open) {
      el.addClass('open').attr('aria-hidden', 'false');
      renderDrawer(); // fresh render every open
    } else {
      el.removeClass('open').attr('aria-hidden', 'true');
    }
  }

  async function renderWidget() {
    const settings = getSettings();
    ensureFab();
    if (!settings.showWidget) {
      $('#srt_fab').hide();
      return;
    }

    const state = await getChatState();
    const revealed = state.npcSecrets.filter(s => !!s.knownToUser).length + state.userSecrets.length + state.mutualSecrets.length;
    const hidden = state.npcSecrets.filter(s => !s.knownToUser).length;

    $('#srt_fab_revealed').text(revealed);
    $('#srt_fab_hidden').text(hidden);
    $('#srt_fab').show();
  }

  function tagOptionsHtml(selected) {
    return Object.keys(TAGS).map(k => {
      const sel = k === selected ? 'selected' : '';
      const t = TAGS[k];
      return `<option value="${k}" ${sel}>${escapeHtml(t.label)}</option>`;
    }).join('');
  }

  function renderItemRow(item, kind) {
    // kind: 'npc' | 'user' | 'mutual'
    const tagIcon = TAGS[item.tag]?.icon ?? '';
    const toggle =
      kind === 'npc'
        ? `<label title="Known to {{user}}"><input type="checkbox" class="srt_toggle_known" data-kind="npc" data-id="${item.id}" ${item.knownToUser ? 'checked' : ''}></label>`
        : kind === 'user'
          ? `<label title="Known to NPC"><input type="checkbox" class="srt_toggle_known" data-kind="user" data-id="${item.id}" ${item.knownToNpc ? 'checked' : ''}></label>`
          : '';

    return `
      <div class="item" data-kind="${kind}" data-id="${item.id}">
        <div class="tag">${tagIcon}</div>
        <div class="txt">${escapeHtml(item.text)}</div>
        ${toggle}
        <button class="srt_delete" data-kind="${kind}" data-id="${item.id}" title="Delete">🗑️</button>
      </div>
    `;
  }

  async function renderDrawer() {
    ensureDrawer();
    const state = await getChatState();

    const npcName = getActiveNpcNameForUi();
    $('#srt_subtitle').text(`Chat: ${npcName}  •  (data is saved per chat)`);

    const revealed = state.npcSecrets.filter(s => !!s.knownToUser).length + state.userSecrets.length + state.mutualSecrets.length;
    const hidden = state.npcSecrets.filter(s => !s.knownToUser).length;

    const html = `
      <div class="section">
        <div class="summary">
          <div class="pill">Раскрыто: <b class="g">${revealed}</b></div>
          <div class="pill">Скрыто: <b class="r">${hidden}</b></div>
        </div>
      </div>

      <div class="section">
        <h4>📖 {{user}} знает о NPC</h4>
        <div class="list">
          ${state.npcSecrets.map(s => renderItemRow(s, 'npc')).join('') || '<div class="item"><div class="txt" style="opacity:.75">—</div></div>'}
        </div>
        <div class="addrow">
          <input type="text" id="srt_add_npc_text" placeholder="New NPC secret…">
          <select id="srt_add_npc_tag">${tagOptionsHtml('none')}</select>
          <label title="Already revealed to {{user}}"><input type="checkbox" id="srt_add_npc_known"> revealed</label>
          <button id="srt_add_npc_btn">Add</button>
        </div>
      </div>

      <div class="section">
        <h4>👁️ NPC знает о {{user}}</h4>
        <div class="list">
          ${state.userSecrets.map(s => renderItemRow(s, 'user')).join('') || '<div class="item"><div class="txt" style="opacity:.75">—</div></div>'}
        </div>
        <div class="addrow">
          <input type="text" id="srt_add_user_text" placeholder="New {{user}} secret…">
          <select id="srt_add_user_tag">${tagOptionsHtml('none')}</select>
          <label title="Known to NPC"><input type="checkbox" id="srt_add_user_known"> known</label>
          <button id="srt_add_user_btn">Add</button>
        </div>
      </div>

      <div class="section">
        <h4>🤝 Mutual secrets (shared)</h4>
        <div class="list">
          ${state.mutualSecrets.map(s => renderItemRow(s, 'mutual')).join('') || '<div class="item"><div class="txt" style="opacity:.75">—</div></div>'}
        </div>
        <div class="addrow">
          <input type="text" id="srt_add_mutual_text" placeholder="New mutual secret…">
          <select id="srt_add_mutual_tag">${tagOptionsHtml('none')}</select>
          <button id="srt_add_mutual_btn">Add</button>
        </div>
      </div>
    `;

    $('#srt_content').html(html);

    // Wire handlers
    $('#srt_add_npc_btn').on('click', () => addSecret('npc'));
    $('#srt_add_user_btn').on('click', () => addSecret('user'));
    $('#srt_add_mutual_btn').on('click', () => addSecret('mutual'));

    $('.srt_delete').on('click', (ev) => {
      const id = $(ev.currentTarget).data('id');
      const kind = $(ev.currentTarget).data('kind');
      deleteSecret(kind, id);
    });

    $('.srt_toggle_known').on('input', (ev) => {
      const id = $(ev.currentTarget).data('id');
      const kind = $(ev.currentTarget).data('kind');
      const checked = Boolean($(ev.currentTarget).prop('checked'));
      toggleKnown(kind, id, checked);
    });
  }

  async function addSecret(kind) {
    const state = await getChatState();
    const { saveMetadata } = ctx();

    if (kind === 'npc') {
      const text = String($('#srt_add_npc_text').val() ?? '').trim();
      const tag = String($('#srt_add_npc_tag').val() ?? 'none');
      const known = Boolean($('#srt_add_npc_known').prop('checked'));
      if (!text) return toastr.warning('Enter secret text');
      state.npcSecrets.unshift({ id: makeId(), text, tag, knownToUser: known });
      $('#srt_add_npc_text').val('');
      $('#srt_add_npc_known').prop('checked', false);
    }

    if (kind === 'user') {
      const text = String($('#srt_add_user_text').val() ?? '').trim();
      const tag = String($('#srt_add_user_tag').val() ?? 'none');
      const known = Boolean($('#srt_add_user_known').prop('checked'));
      if (!text) return toastr.warning('Enter secret text');
      state.userSecrets.unshift({ id: makeId(), text, tag, knownToNpc: known });
      $('#srt_add_user_text').val('');
      $('#srt_add_user_known').prop('checked', false);
    }

    if (kind === 'mutual') {
      const text = String($('#srt_add_mutual_text').val() ?? '').trim();
      const tag = String($('#srt_add_mutual_tag').val() ?? 'none');
      if (!text) return toastr.warning('Enter secret text');
      state.mutualSecrets.unshift({ id: makeId(), text, tag });
      $('#srt_add_mutual_text').val('');
    }

    await saveMetadata();
    await updateInjectedPrompt();
    await renderDrawer();
  }

  async function deleteSecret(kind, id) {
    const state = await getChatState();
    const { saveMetadata } = ctx();

    const list =
      kind === 'npc' ? state.npcSecrets :
      kind === 'user' ? state.userSecrets :
      state.mutualSecrets;

    const idx = list.findIndex(x => x.id === id);
    if (idx >= 0) list.splice(idx, 1);

    await saveMetadata();
    await updateInjectedPrompt();
    await renderDrawer();
  }

  async function toggleKnown(kind, id, value) {
    const state = await getChatState();
    const { saveMetadata } = ctx();

    if (kind === 'npc') {
      const it = state.npcSecrets.find(x => x.id === id);
      if (it) it.knownToUser = value;
    }
    if (kind === 'user') {
      const it = state.userSecrets.find(x => x.id === id);
      if (it) it.knownToNpc = value;
    }

    await saveMetadata();
    await updateInjectedPrompt();
    // no full re-render needed; widget+prompt updated.
  }

  async function exportJson() {
    const state = await getChatState();
    const data = JSON.stringify(state, null, 2);
    await ctx().Popup.show.text('SRT Export (copy this JSON)', `<pre style="white-space:pre-wrap">${escapeHtml(data)}</pre>`);
  }

  async function importJson() {
    const { Popup, saveMetadata, chatMetadata } = ctx();
    const raw = await Popup.show.input('SRT Import', 'Paste previously exported JSON:', '');
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw);
      // minimal validation
      if (!parsed || typeof parsed !== 'object') throw new Error('Not an object');
      parsed.npcSecrets = Array.isArray(parsed.npcSecrets) ? parsed.npcSecrets : [];
      parsed.userSecrets = Array.isArray(parsed.userSecrets) ? parsed.userSecrets : [];
      parsed.mutualSecrets = Array.isArray(parsed.mutualSecrets) ? parsed.mutualSecrets : [];
      parsed.npcLabel = typeof parsed.npcLabel === 'string' ? parsed.npcLabel : '{{char}}';
      chatMetadata[CHAT_KEY] = parsed;
      await saveMetadata();
      await updateInjectedPrompt();
      toastr.success('Imported');
      renderDrawer();
    } catch (e) {
      console.error('[SRT] import failed', e);
      toastr.error('Invalid JSON');
    }
  }

  // ---------------- Settings UI (Extensions panel) ----------------

  async function mountSettingsUi() {
    const html = `
      <div class="srt-settings-block">
        <div class="srt-title">🔐 Secrets &amp; Revelations Tracker</div>

        <div class="srt-row">
          <label class="checkbox_label">
            <input type="checkbox" id="srt_enabled">
            <span>Enable prompt injection</span>
          </label>
        </div>

        <div class="srt-row">
          <label class="checkbox_label">
            <input type="checkbox" id="srt_show_widget">
            <span>Show floating widget</span>
          </label>
        </div>

        <div class="srt-row srt-row-slim">
          <button class="menu_button" id="srt_open_drawer">Open Tracker</button>
          <button class="menu_button" id="srt_export_json">Export JSON</button>
          <button class="menu_button" id="srt_import_json">Import JSON</button>
        </div>

        <div class="srt-hint">
          Tips:
          <ul>
            <li>Secrets are saved <b>per chat</b> (chat metadata).</li>
            <li>Prompt injection uses <code>setExtensionPrompt()</code> so nothing is added to your chat log.</li>
          </ul>
        </div>
      </div>
    `;

    const target = $('#extensions_settings2').length ? '#extensions_settings2' : '#extensions_settings';
    if (!$(target).length) {
      console.warn('[SRT] settings container not found');
      return;
    }

    // Avoid duplicates if ST hot-reloads extensions
    if ($('#srt_enabled').length) return;

    $(target).append(html);

    // Init values
    const s = getSettings();
    $('#srt_enabled').prop('checked', !!s.enabled);
    $('#srt_show_widget').prop('checked', !!s.showWidget);

    // Handlers
    $('#srt_enabled').on('input', async (ev) => {
      const { saveSettingsDebounced } = ctx();
      s.enabled = Boolean($(ev.currentTarget).prop('checked'));
      saveSettingsDebounced();
      await updateInjectedPrompt();
    });

    $('#srt_show_widget').on('input', async (ev) => {
      const { saveSettingsDebounced } = ctx();
      s.showWidget = Boolean($(ev.currentTarget).prop('checked'));
      saveSettingsDebounced();
      await renderWidget();
    });

    $('#srt_open_drawer').on('click', () => openDrawer(true));
    $('#srt_export_json').on('click', () => exportJson());
    $('#srt_import_json').on('click', () => importJson());

  }

  function wireChatEvents() {
    const { eventSource, event_types } = ctx();

    eventSource.on(event_types.APP_READY, async () => {
      ensureFab();
      ensureDrawer();
      await mountSettingsUi();
      await updateInjectedPrompt();
    });

    eventSource.on(event_types.CHAT_CHANGED, async () => {
      // re-sync prompt + widget for the new chat
      await updateInjectedPrompt();
      // if drawer is open, re-render it
      if ($('#srt_drawer').hasClass('open')) renderDrawer();
    });
  }

  // ---------------- Boot ----------------
  jQuery(() => {
    try {
      wireChatEvents();
      console.log('[SRT] loaded');
    } catch (e) {
      console.error('[SRT] failed to init', e);
    }
  });

})();
