/**
 * 世界书分组管理（重制版）
 * SillyTavern World Info Group Manager (Remastered)
 *
 * 修复要点：
 *  1. 分组数据不再写入世界书文件，而是存入 ST 的 extension_settings（settings.json）。
 *     这样 ST 编辑器对世界书文件的任何原生保存（编辑条目、拖拽排序、批量操作等）
 *     都不会覆盖分组数据，彻底解决"刷新后分组消失"的问题。
 *  2. 重新设计了分组卡片 UI，兼容移动端（触屏友好）。
 *  3. 自动迁移旧版插件（ST-WI-Group-Manager 0.3.x）写入世界书文件的分组数据。
 *
 * 安装方式：放入 public/scripts/extensions/third-party/<本目录>/ 后刷新页面。
 */

import { event_types, eventSource, saveSettingsDebounced } from '../../../../script.js';
import { extension_settings } from '../../../extensions.js';
import { loadWorldInfo, saveWorldInfo } from '../../../world-info.js';
import { uuidv4, escapeHtml } from '../../../utils.js';

// ---------------------------------------------------------------------------
// 常量与状态
// ---------------------------------------------------------------------------

/** 本插件在 extension_settings 中的存储键 */
const SETTINGS_KEY = 'wi_group_manager_v2';

/** 旧版插件（ST-WI-Group-Manager）写入世界书文件 extensions 的键 */
const LEGACY_WORLD_KEY = 'st_wi_group_manager';

/** 条目列表选择器 */
const ENTRIES_LIST_SELECTOR = '#world_popup_entries_list';
const ENTRY_SELECTOR = `${ENTRIES_LIST_SELECTOR} .world_entry`;

/** 当前正在编辑的世界书名 */
let currentWorld = '';
/** 分组容器（#wi_group_container） */
let container = null;
/** MutationObserver，监听条目列表变化后重渲染 */
let observer = null;
/** 防止重复渲染的定时器 */
let renderTimer = null;
let renderQueued = false;
/** 迁移标记，避免每次打开都尝试迁移 */
const migratedWorlds = new Set();

// ---------------------------------------------------------------------------
// 设置读写（分组数据全部存这里，绝不写入世界书文件）
// ---------------------------------------------------------------------------

/**
 * 规范化分组数组（就地修正字段，保持对象引用不变，避免修改副本导致不落盘）
 */
function normalizeGroups(groups) {
    if (!Array.isArray(groups)) return [];
    for (const g of groups) {
        if (!g || typeof g !== 'object' || !g.id) continue;
        g.id = String(g.id);
        g.name = String(g.name || '未命名分组');
        g.entries = [...new Set(Array.isArray(g.entries) ? g.entries.map(String) : [])];
    }
    return groups.filter(g => g && typeof g === 'object' && g.id);
}

/**
 * 确保 settings 结构存在
 */
function ensureSettings() {
    if (!extension_settings[SETTINGS_KEY] || typeof extension_settings[SETTINGS_KEY] !== 'object') {
        extension_settings[SETTINGS_KEY] = { worlds: {} };
    }
    const s = extension_settings[SETTINGS_KEY];
    if (!s.worlds || typeof s.worlds !== 'object') {
        s.worlds = {};
    }
    return s;
}

/**
 * 获取某本世界书的分组存储
 */
function getWorldStore(worldName, create = false) {
    const s = ensureSettings();
    if (!worldName) return null;
    if (!s.worlds[worldName]) {
        if (!create) return null;
        s.worlds[worldName] = { groups: [], expanded: {} };
    }
    const store = s.worlds[worldName];
    if (!Array.isArray(store.groups)) store.groups = [];
    if (!store.expanded || typeof store.expanded !== 'object') store.expanded = {};
    store.groups = normalizeGroups(store.groups);
    return store;
}

function getGroups(worldName = currentWorld) {
    const store = getWorldStore(worldName, false);
    return store ? store.groups : [];
}

function setExpanded(worldName, groupId, value) {
    const store = getWorldStore(worldName, true);
    if (value) {
        delete store.expanded[groupId];
    } else {
        store.expanded[groupId] = false;
    }
    saveSettingsDebounced();
}

function isExpanded(worldName, groupId) {
    const store = getWorldStore(worldName, false);
    return store ? store.expanded[groupId] !== false : true;
}

function persistSettings() {
    saveSettingsDebounced();
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

/** 从 #world_editor_select 获取当前世界书名 */
function getEditorWorld() {
    const sel = document.querySelector('#world_editor_select');
    if (!sel) return '';
    const idx = sel.selectedIndex;
    return idx >= 0 ? sel.options[idx].text : '';
}

/** 从 DOM 收集当前可见的世界书条目 uid 列表（按 DOM 顺序） */
function getRenderedUids() {
    return Array.from(document.querySelectorAll(ENTRY_SELECTOR))
        .map(el => String(el.getAttribute('uid') || ''))
        .filter(Boolean);
}

/** 从 DOM 拿一个条目的标题（优先 comment，其次 key） */
function getEntryTitleFromDom(el) {
    if (!el) return '';
    const comment = el.querySelector('.world_entry_comment_edit');
    const memo = el.querySelector('[data-i18n="Title/Memo"], .world_entry_memo, .entry_comment');
    const key = el.querySelector('.world_entry_key_edit, .world_entry_keys');
    if (comment && comment.value) return comment.value.trim();
    if (memo && memo.textContent) return memo.textContent.trim();
    if (key && key.value) return key.value.trim();
    return '';
}

// ---------------------------------------------------------------------------
// 渲染
// ---------------------------------------------------------------------------

/**
 * 渲染分组视图：把分组条目挪进分组卡片，未分组条目留在列表底部
 */
function render() {
    const list = document.querySelector(ENTRIES_LIST_SELECTOR);
    if (!list) return;
    currentWorld = getEditorWorld();

    // 防御性清理：移除所有不属于当前引用的重复容器（避免多实例/竞态导致同分组被渲染多份）
    for (const c of Array.from(document.querySelectorAll('#wi_group_container'))) {
        if (c !== container) {
            for (const el of Array.from(c.querySelectorAll('.world_entry'))) list.appendChild(el);
            c.remove();
        }
    }

    // 确保容器存在且挂在当前列表下
    if (!container || !container.isConnected || container.parentNode !== list) {
        container = document.createElement('div');
        container.id = 'wi_group_container';
        list.appendChild(container);
    }

    // 关键：先把容器内残留的条目 DOM 移回列表，避免后续清空容器时销毁条目节点
    for (const el of Array.from(container.querySelectorAll('.world_entry'))) {
        list.appendChild(el);
    }

    if (!currentWorld) {
        restoreNativeList();
        container.style.display = 'none';
        return;
    }

    const groups = getGroups(currentWorld);
    const header = document.querySelector('#WIEntryHeaderTitlesPC');

    // 没有任何分组时，恢复原生列表
    if (!groups.length) {
        restoreNativeList();
        container.style.display = 'none';
        if (header) header.style.display = '';
        return;
    }

    // 收集条目 DOM
    const entryEls = new Map();
    for (const el of Array.from(list.querySelectorAll('.world_entry'))) {
        const uid = String(el.getAttribute('uid') || '');
        if (uid) entryEls.set(uid, el);
    }

    // 隐藏原生表头，用分组布局
    if (header) header.style.display = 'none';

    container.style.display = 'block';
    container.innerHTML = '';

    const groupedUids = new Set();
    for (const group of groups) {
        const section = document.createElement('div');
        section.className = 'wi-group-card';
        section.dataset.groupId = group.id;

        const expanded = isExpanded(currentWorld, group.id);

        // ---- 分组头 ----
        const head = document.createElement('div');
        head.className = 'wi-group-head';

        const toggle = document.createElement('button');
        toggle.type = 'button';
        toggle.className = 'wi-group-expand';
        toggle.title = expanded ? '收起分组' : '展开分组';
        toggle.innerHTML = `<i class="fa-solid fa-chevron-${expanded ? 'down' : 'right'}"></i>`;

        const title = document.createElement('span');
        title.className = 'wi-group-title';
        title.textContent = group.name;
        title.title = group.name;

        const count = document.createElement('span');
        count.className = 'wi-group-count';
        count.textContent = String((group.entries || []).length);

        const actions = document.createElement('span');
        actions.className = 'wi-group-actions';

        const btnAssign = document.createElement('button');
        btnAssign.type = 'button';
        btnAssign.className = 'wi-group-action';
        btnAssign.title = '选择组内条目';
        btnAssign.innerHTML = '<i class="fa-solid fa-list-check"></i>';
        btnAssign.addEventListener('click', e => { e.stopPropagation(); openGroupEditor(group.id); });

        const btnEnable = document.createElement('button');
        btnEnable.type = 'button';
        btnEnable.className = 'wi-group-action';
        btnEnable.title = '批量启用/停用组内条目';
        btnEnable.innerHTML = '<i class="fa-solid fa-toggle-on"></i>';
        btnEnable.addEventListener('click', e => { e.stopPropagation(); toggleGroupEntries(group.id); });

        const btnRename = document.createElement('button');
        btnRename.type = 'button';
        btnRename.className = 'wi-group-action';
        btnRename.title = '重命名分组';
        btnRename.innerHTML = '<i class="fa-solid fa-pen"></i>';
        btnRename.addEventListener('click', e => { e.stopPropagation(); renameGroup(group.id); });

        const btnDelete = document.createElement('button');
        btnDelete.type = 'button';
        btnDelete.className = 'wi-group-action wi-group-action-danger';
        btnDelete.title = '删除分组（不删除条目）';
        btnDelete.innerHTML = '<i class="fa-solid fa-trash-can"></i>';
        btnDelete.addEventListener('click', e => { e.stopPropagation(); deleteGroup(group.id); });

        actions.append(btnAssign, btnEnable, btnRename, btnDelete);
        head.append(toggle, title, count, actions);

        // 点击分组头展开/收起
        toggle.addEventListener('click', e => {
            e.stopPropagation();
            const next = !isExpanded(currentWorld, group.id);
            setExpanded(currentWorld, group.id, next);
            section.classList.toggle('collapsed', !next);
            toggle.innerHTML = `<i class="fa-solid fa-chevron-${next ? 'down' : 'right'}"></i>`;
            toggle.title = next ? '收起分组' : '展开分组';
        });

        // ---- 分组体 ----
        const body = document.createElement('div');
        body.className = 'wi-group-body';
        if (!expanded) section.classList.add('collapsed');

        for (const uid of group.entries || []) {
            const el = entryEls.get(String(uid));
            if (!el) continue; // 条目已删除或不存在，跳过
            groupedUids.add(String(uid));
            body.appendChild(el);
        }
        section.append(head, body);
        container.appendChild(section);
    }

    // 未分组条目回到列表底部（原生渲染）
    for (const [uid, el] of entryEls) {
        if (!groupedUids.has(uid)) {
            list.appendChild(el);
        }
    }

    // 给每个条目挂上"归组"按钮
    attachEntryGroupButtons(entryEls);
}

/**
 * 在每个条目右侧添加"设置分组"按钮。
 * 按钮本身不绑定监听器，点击通过 document 级事件委托统一处理（见 init()），
 * 避免按钮被 ST 重渲染/节点移动后监听器丢失的问题。
 */
function attachEntryGroupButtons(entryEls) {
    for (const [uid, el] of entryEls) {
        let btn = el.querySelector('.wi-entry-group-btn');
        if (btn) {
            btn.dataset.uid = uid;
            continue;
        }
        btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'wi-entry-group-btn menu_button';
        btn.title = '设置条目分组';
        btn.dataset.uid = uid;
        btn.innerHTML = '<i class="fa-solid fa-folder"></i>';
        const moveBtn = el.querySelector('.move_entry_button');
        if (moveBtn && moveBtn.parentNode) {
            moveBtn.parentNode.insertBefore(btn, moveBtn);
        } else {
            el.appendChild(btn);
        }
    }
}

/** 恢复原生条目列表顺序（把分组体内的条目移回列表，清空容器） */
function restoreNativeList() {
    const list = document.querySelector(ENTRIES_LIST_SELECTOR);
    if (!list) return;
    const header = document.querySelector('#WIEntryHeaderTitlesPC');
    if (header) header.style.display = '';
    if (container && container.parentNode === list) {
        // 把分组体内的条目移回列表
        const entries = container.querySelectorAll('.world_entry');
        for (const el of entries) {
            list.appendChild(el);
        }
        container.remove();
        // 不置 null：render() 会通过 parentNode 判断重建容器
    }
}

/** 队列化渲染，防抖 */
function queueRender() {
    if (renderQueued) return;
    renderQueued = true;
    renderTimer = setTimeout(() => {
        renderQueued = false;
        renderTimer = null;
        try { render(); } catch (e) { console.error('[WI Group Manager] render failed', e); }
    }, 60);
}

// ---------------------------------------------------------------------------
// 原生弹窗（不依赖 ST 的 popup.js，兼容各版本 ST）
// ---------------------------------------------------------------------------

/**
 * 通用原生模态弹窗。
 * @param {object} opts
 *  - title: 标题文字
 *  - content: HTMLElement，放入弹窗主体
 *  - okText: 确定按钮文字（默认 '确定'；传 null 隐藏）
 *  - cancelText: 取消按钮文字（默认 '取消'；传 null 隐藏）
 *  - wide: 是否更宽（移动端友好）
 *  - onOk: 点击确定时回调；返回 false 则不关闭；返回其它值会作为弹窗结果返回
 * @returns {Promise<*>} 确定返回 true（或 onOk 的返回值），取消/关闭返回 null
 */
function wiDialog(opts) {
    let root = document.querySelector('.wi-dialog-root');
    if (!root) {
        root = document.createElement('div');
        root.className = 'wi-dialog-root';
        document.body.appendChild(root);
    }
    return new Promise(resolve => {
        const mask = document.createElement('div');
        mask.className = 'wi-dialog-mask';
        const panel = document.createElement('div');
        panel.className = 'wi-dialog-panel' + (opts.wide ? ' wi-dialog-wide' : '');
        const titleHTML = opts.title ? `<div class="wi-dialog-title">${escapeHtml(opts.title)}</div>` : '';
        const okBtnHTML = opts.okText !== null
            ? `<button type="button" class="menu_button wi-dialog-ok">${escapeHtml(opts.okText ?? '确定')}</button>` : '';
        const cancelBtnHTML = opts.cancelText !== null
            ? `<button type="button" class="menu_button wi-dialog-cancel">${escapeHtml(opts.cancelText ?? '取消')}</button>` : '';
        panel.innerHTML = `
            ${titleHTML}
            <div class="wi-dialog-body"></div>
            <div class="wi-dialog-actions">
                ${cancelBtnHTML}
                ${okBtnHTML}
            </div>
        `;
        panel.querySelector('.wi-dialog-body').appendChild(opts.content);
        mask.appendChild(panel);
        root.appendChild(mask);

        let done = false;
        function close(value) {
            if (done) return;
            done = true;
            mask.remove();
            resolve(value);
        }
        panel.querySelector('.wi-dialog-cancel')?.addEventListener('click', () => close(null));
        panel.querySelector('.wi-dialog-ok')?.addEventListener('click', () => {
            const r = opts.onOk ? opts.onOk() : true;
            if (r === false) return;
            close(r === true ? true : r);
        });
        mask.addEventListener('click', e => { if (e.target === mask) close(null); });
    });
}

// ---------------------------------------------------------------------------
// 分组操作
// ---------------------------------------------------------------------------

/**
 * 通用文本输入弹窗（原生实现，不依赖 ST popup API）
 * @returns {Promise<string|null>} 输入值（已 trim），取消返回 null
 */
function promptInput(label, defaultValue = '') {
    const content = document.createElement('div');
    content.className = 'wi-prompt-dialog';
    content.innerHTML = `
        <label class="wi-prompt-label">${escapeHtml(label)}</label>
        <input class="text_pole wi-prompt-input" type="text" value="${escapeHtml(defaultValue)}">
    `;
    const inputEl = content.querySelector('.wi-prompt-input');
    setTimeout(() => { inputEl.focus(); inputEl.select(); }, 50);
    return wiDialog({
        title: label,
        content,
        okText: '确定',
        cancelText: '取消',
        onOk: () => {
            const v = inputEl.value.trim();
            if (!v) return false; // 空输入不关闭，让用户继续输入
            return v;
        },
    });
}

async function createGroup() {
    const world = getEditorWorld();
    if (!world) {
        toastr.warning('请先选择一本世界书。');
        return;
    }
    const name = await promptInput('分组名称', '新建分组');
    if (!name) return;
    const store = getWorldStore(world, true);
    store.groups.push({ id: uuidv4(), name, entries: [] });
    persistSettings();
    queueRender();
}

async function renameGroup(groupId) {
    const store = getWorldStore(currentWorld, true);
    const group = store.groups.find(g => g.id === groupId);
    if (!group) return;
    const name = await promptInput('分组名称', group.name);
    if (!name) return;
    group.name = name;
    persistSettings();
    queueRender();
}

async function deleteGroup(groupId) {
    const store = getWorldStore(currentWorld, true);
    const group = store.groups.find(g => g.id === groupId);
    if (!group) return;
    const content = document.createElement('div');
    content.className = 'wi-confirm-dialog';
    content.innerHTML = `<p>确定删除分组“${escapeHtml(group.name)}”吗？组内的世界书条目不会被删除。</p>`;
    const ok = await wiDialog({ title: '删除分组', content, okText: '删除', cancelText: '取消' });
    if (!ok) return;
    store.groups = store.groups.filter(g => g.id !== groupId);
    delete store.expanded[groupId];
    persistSettings();
    queueRender();
}

/**
 * 将单个条目归入某个分组（弹出选择对话框）
 */
async function assignEntry(uid, entryEl) {
    const world = currentWorld;
    const store = getWorldStore(world, true);
    const groups = store.groups;
    const owner = groups.find(g => (g.entries || []).includes(uid));

    const createValue = '__create__';
    const options = groups.map(g =>
        `<option value="${escapeHtml(g.id)}" ${owner?.id === g.id ? 'selected' : ''}>${escapeHtml(g.name)}</option>`
    ).join('');

    const content = document.createElement('div');
    content.className = 'wi-assign-dialog';
    content.innerHTML = `
        <label>将条目 #${escapeHtml(uid)} 放入分组</label>
        <select class="text_pole wi-assign-select">
            <option value="">不属于任何分组</option>
            ${options}
            <option value="${createValue}">新建分组…</option>
        </select>
        <div class="wi-assign-new" hidden>
            <label>新分组名称</label>
            <input class="text_pole wi-assign-new-name" type="text" value="新建分组">
        </div>
    `;
    const select = content.querySelector('.wi-assign-select');
    const newWrap = content.querySelector('.wi-assign-new');
    const newName = content.querySelector('.wi-assign-new-name');
    select.addEventListener('change', () => {
        const creating = select.value === createValue;
        newWrap.hidden = !creating;
        if (creating) newName.focus();
    });

    await wiDialog({
        title: `将条目 #${uid} 放入分组`,
        content,
        okText: '保存',
        cancelText: '取消',
        onOk: () => {
            let targetId = select.value;
            if (targetId === createValue) {
                const name = newName.value.trim() || '新建分组';
                const g = { id: uuidv4(), name, entries: [] };
                store.groups.push(g);
                targetId = g.id;
            }
            // 从所有分组移除该条目，再加入目标分组
            for (const g of store.groups) {
                g.entries = (g.entries || []).filter(e => e !== uid);
                if (g.id === targetId) g.entries.push(uid);
            }
            persistSettings();
            queueRender();
            return true;
        },
    });
}

/**
 * 批量选择组内条目（弹窗：搜索 + 复选框）
 */
async function openGroupEditor(groupId) {
    const world = currentWorld;
    const store = getWorldStore(world, true);
    const group = store.groups.find(g => g.id === groupId);
    if (!group) return;

    // 读取世界书数据以列出全部条目
    let data = null;
    try { data = await loadWorldInfo(world); } catch (e) { console.error(e); }
    if (!data || !data.entries) {
        toastr.error('无法读取世界书条目数据。');
        return;
    }
    const entries = Object.values(data.entries)
        .filter(e => e && typeof e === 'object')
        .sort((a, b) => Number(a.uid) - Number(b.uid));
    const selected = new Set((group.entries || []).map(String));

    const card = document.createElement('div');
    card.className = 'wi-group-editor-card';
    card.innerHTML = `
        <input class="text_pole wi-group-editor-search" type="search" placeholder="搜索条目名称或编号">
        <div class="wi-group-editor-list"></div>
        <div class="wi-group-editor-actions">
            <button type="button" class="menu_button wi-group-editor-save"><i class="fa-solid fa-floppy-disk"></i> 保存</button>
            <button type="button" class="menu_button wi-group-editor-clear"><i class="fa-solid fa-square-minus"></i> 清空</button>
        </div>
    `;
    const listEl = card.querySelector('.wi-group-editor-list');
    const searchEl = card.querySelector('.wi-group-editor-search');

    function titleOf(e) {
        const c = String(e.comment || '').trim();
        if (c) return c;
        const k = Array.isArray(e.key) ? e.key.filter(Boolean).join(', ') : '';
        if (k) return k;
        return `条目 ${e.uid}`;
    }
    function paint(filter = '') {
        const q = filter.trim().toLowerCase();
        listEl.innerHTML = entries
            .filter(e => !q || titleOf(e).toLowerCase().includes(q) || String(e.uid).includes(q))
            .map(e => {
                const isIn = selected.has(String(e.uid));
                return `<label class="wi-group-editor-entry">
                    <input type="checkbox" value="${escapeHtml(String(e.uid))}" ${isIn ? 'checked' : ''}>
                    <span class="wi-group-editor-title">#${escapeHtml(String(e.uid))} ${escapeHtml(titleOf(e))}</span>
                </label>`;
            }).join('');
    }
    listEl.addEventListener('change', ev => {
        const cb = ev.target;
        if (cb.type !== 'checkbox') return;
        if (cb.checked) selected.add(cb.value); else selected.delete(cb.value);
    });
    searchEl.addEventListener('input', () => paint(searchEl.value));
    card.querySelector('.wi-group-editor-save').addEventListener('click', async () => {
        group.entries = Array.from(selected);
        persistSettings();
        queueRender();
        toastr.success('分组条目已保存。');
    });
    card.querySelector('.wi-group-editor-clear').addEventListener('click', () => {
        selected.clear();
        paint(searchEl.value);
    });
    paint();

    await wiDialog({
        title: '编辑分组条目',
        content: card,
        okText: null,
        cancelText: '关闭',
        wide: true,
    });
}

/**
 * 一键启用/停用组内全部条目
 */
async function toggleGroupEntries(groupId) {
    const world = currentWorld;
    const store = getWorldStore(world, true);
    const group = store.groups.find(g => g.id === groupId);
    if (!group) return;
    const uids = new Set((group.entries || []).map(String));

    let data = null;
    try { data = await loadWorldInfo(world); } catch (e) { console.error(e); }
    if (!data || !data.entries) {
        toastr.error('无法读取世界书条目数据。');
        return;
    }
    const entries = Object.values(data.entries).filter(e => e && (uids.has(String(e.uid))));
    if (!entries.length) {
        toastr.info('组内没有条目。');
        return;
    }
    const anyEnabled = entries.some(e => !e.disable);
    const nextDisable = anyEnabled; // 有启用中的 → 全部停用；否则全部启用
    for (const e of entries) {
        e.disable = nextDisable;
    }
    // 同步更新页面上的开关按钮
    document.querySelectorAll(ENTRY_SELECTOR).forEach(el => {
        const uid = String(el.getAttribute('uid') || '');
        if (!uids.has(uid)) return;
        const sw = el.querySelector('[name="entryKillSwitch"]');
        if (sw) {
            const isOff = sw.classList.contains('fa-toggle-off');
            if (isOff !== nextDisable) sw.click();
        }
    });
    // 保存世界书（用 ST 提供的 saveWorldInfo，保证与 ST 状态一致）
    await saveWorldInfo(world, data, true);
    toastr.success(nextDisable ? `已停用 ${entries.length} 个条目。` : `已启用 ${entries.length} 个条目。`);
}

// ---------------------------------------------------------------------------
// 旧版数据迁移（一次性）
// ---------------------------------------------------------------------------

/**
 * 从旧版插件（st_wi_group_manager）写入世界书文件的扩展字段中读取分组数据，
 * 迁移到本插件的 settings 存储。
 */
async function migrateLegacy(world) {
    if (migratedWorlds.has(world)) return;
    const store = getWorldStore(world, false);
    if (store && store.groups.length) {
        migratedWorlds.add(world);
        return; // 已有新数据，无需迁移
    }
    let data = null;
    try { data = await loadWorldInfo(world); } catch (e) { /* ignore */ }
    if (!data || !data.entries) {
        migratedWorlds.add(world);
        return;
    }
    const legacy = data.extensions?.[LEGACY_WORLD_KEY];
    let groups = Array.isArray(legacy?.groups) ? legacy.groups : null;
    if (!groups) {
        // 旧版在条目扩展字段里存了 catalog，尝试重建
        const byId = new Map();
        for (const e of Object.values(data.entries)) {
            const m = e.extensions?.[LEGACY_WORLD_KEY];
            if (!m) continue;
            if (Array.isArray(m.catalog)) {
                for (const g of m.catalog) {
                    if (g && g.id && !byId.has(g.id)) byId.set(g.id, { id: g.id, name: g.name || '未命名分组', entries: [] });
                }
            }
        }
        for (const e of Object.values(data.entries)) {
            const m = e.extensions?.[LEGACY_WORLD_KEY];
            if (!m || !m.groupId) continue;
            const g = byId.get(String(m.groupId));
            if (g) g.entries.push(String(e.uid));
        }
        if (byId.size) groups = Array.from(byId.values());
    }
    if (groups && groups.length) {
        const s = getWorldStore(world, true);
        s.groups = normalizeGroups(groups);
        persistSettings();
        console.info(`[WI Group Manager] 已从旧版插件迁移 ${groups.length} 个分组到「${world}」。`);
    }
    migratedWorlds.add(world);
}

// ---------------------------------------------------------------------------
// 事件与初始化
// ---------------------------------------------------------------------------

function ensureObserver() {
    const list = document.querySelector(ENTRIES_LIST_SELECTOR);
    if (!list || observer) return;
    observer = new MutationObserver(mutations => {
        const hasEntryChange = mutations.some(m =>
            Array.from(m.addedNodes).some(n =>
                n instanceof Element && (n.matches('.world_entry') || n.querySelector('.world_entry'))
            )
        );
        if (hasEntryChange) queueRender();
    });
    observer.observe(list, { childList: true });
}

function initObservers() {
    // 事件监听始终注册（不依赖条目列表是否已渲染，避免"先开抽屉后选世界书"时静默失效）
    // 切换世界书
    document.querySelector('#world_editor_select')?.addEventListener('change', async () => {
        currentWorld = getEditorWorld();
        if (currentWorld) await migrateLegacy(currentWorld);
        ensureObserver();
        queueRender();
    });

    // 搜索 / 排序 / 分页变化后重渲染
    document.querySelector('#world_info_search')?.addEventListener('input', queueRender);
    document.querySelector('#world_info_sort_order')?.addEventListener('change', queueRender);
    document.querySelector('#world_info_pagination')?.addEventListener('click', queueRender);

    // 世界书数据被保存后重渲染（分组定义不受影响，仅刷新条目归属）
    eventSource.on(event_types.WORLDINFO_UPDATED, name => {
        if (name && name === getEditorWorld()) queueRender();
    });

    // 初次尝试初始化 observer
    ensureObserver();
}

/**
 * 在"新建条目"按钮旁加入"新建分组"按钮
 */
function ensureCreateButton() {
    const nativeNew = document.querySelector('#world_popup_new');
    if (!nativeNew || document.querySelector('#wi_group_create_btn')) return;
    const btn = document.createElement('div');
    btn.id = 'wi_group_create_btn';
    btn.className = 'menu_button fa-solid fa-folder-plus';
    btn.title = '新建分组';
    btn.addEventListener('click', () => createGroup());
    const wrap = document.createElement('div');
    wrap.className = 'wi-group-create-controls';
    nativeNew.parentNode?.insertBefore(wrap, nativeNew);
    wrap.appendChild(nativeNew);
    wrap.appendChild(btn);
}

async function init() {
    ensureSettings();
    ensureCreateButton();
    initObservers();

    // 事件委托：归组按钮点击（在 document 层捕获，按钮无论何时/如何创建都能触发，
    // 彻底规避 ST 重渲染/节点移动导致按钮监听器丢失的问题）
    document.addEventListener('click', ev => {
        const target = ev.target instanceof Element ? ev.target.closest('.wi-entry-group-btn') : null;
        if (!target) return;
        const entryEl = target.closest('.world_entry');
        const uid = target.dataset.uid || (entryEl ? entryEl.getAttribute('uid') : '');
        if (!uid) return;
        assignEntry(uid, entryEl);
    });
    // 打开世界书抽屉时初始化
    document.querySelector('#WIDrawerIcon')?.addEventListener('click', async () => {
        currentWorld = getEditorWorld();
        if (currentWorld) await migrateLegacy(currentWorld);
        ensureObserver();
        queueRender();
    });
    // ST 完全就绪后再渲染（此时世界书条目列表通常已加载）
    eventSource.once(event_types.APP_READY, () => {
        currentWorld = getEditorWorld();
        if (currentWorld) migrateLegacy(currentWorld);
        ensureObserver();
        queueRender();
    });
    // 世界书设置被加载/更新后重渲染（刷新时自动恢复世界书不会触发 change 事件）
    eventSource.on(event_types.WORLDINFO_SETTINGS_UPDATED, () => {
        ensureObserver();
        queueRender();
    });
    currentWorld = getEditorWorld();
    if (currentWorld) await migrateLegacy(currentWorld);
    queueRender();
    // 兜底：条目列表出现前持续重试，确保"刷新自动恢复世界书"等不触发 change 的场景也能渲染
    let tries = 0;
    const retry = setInterval(() => {
        tries++;
        ensureObserver();
        queueRender();
        if (tries >= 10 || document.querySelector('#wi_group_container')) clearInterval(retry);
    }, 500);
}

$(document).ready(init);
