(function () {
    'use strict';

    // ===== ЗНАЧЕНИЯ ПО УМОЛЧАНИЮ =====
    var DEF_URL = 'http://192.168.1.50:8080';
    var DEF_USER = '';
    var DEF_PASS = '';
    var DEF_BYPASS = true;
    var DEF_SAVEPATH = '';
    var DEF_CATEGORY = '';
    var DEF_RENAME = true;
    var DEF_CONFIRM = true;
    var DEF_AUTO_CAT_PATH = true;

    var DEF_PLAYER = 'vimu';
    var DEF_PLAYER_PKG = '';
    var DEF_LOCAL_PREFIX = 'smb://192.168.1.50/qBittorrent';
    var DEF_POLL_MS = 5000;
    var DEF_SHOW_DELETE = true;
    // =================================

    var DEBUG = true;
    var ACTION_LOCK_MS = 1000;
    var CT_FORM = { 'Content-Type': 'application/x-www-form-urlencoded' };

    var PLAYERS = {
        'vimu':    { pkg: 'net.gtvbox.videoplayer',   name: 'Vimu Player' },
        'vlc':     { pkg: 'org.videolan.vlc',         name: 'VLC' },
        'mx':      { pkg: 'com.mxtech.videoplayer.ad', name: 'MX Player' },
        'kodi':    { pkg: 'org.xbmc.kodi',            name: 'Kodi' },
        'just':    { pkg: 'com.brouken.player',       name: 'Just (Video) Player' },
        'nplayer': { pkg: 'com.newin.nplayer.pro',    name: 'nPlayer' }
    };

    function notify(text) {
        try {
            if (window.Lampa && Lampa.Noty) {
                Lampa.Noty.show(text);
                return;
            }
        } catch (e) {
            console.warn('[qBittorrent-custom] notify error:', e);
        }
        console.log('[qBittorrent-custom]', text);
    }

    function debugNotify(text) {
        if (DEBUG) notify(text);
    }

    function storeGet(key, def) {
        try {
            if (window.Lampa && Lampa.Storage) {
                var v = Lampa.Storage.get(key, def);
                if (v !== undefined && v !== null) return v;
            }
        } catch (e) {}
        return def;
    }

    function storeSet(key, val) {
        try {
            if (window.Lampa && Lampa.Storage) {
                Lampa.Storage.set(key, val);
                return;
            }
        } catch (e) {}
    }

    function isTrue(v, def) {
        if (v === true || v === 'true') return true;
        if (v === false || v === 'false') return false;
        return def;
    }

    function cfg() {
        return {
            url: storeGet('qbitc_url', DEF_URL),
            user: storeGet('qbitc_user', DEF_USER),
            pass: storeGet('qbitc_pass', DEF_PASS),
            bypass: isTrue(storeGet('qbitc_bypass', DEF_BYPASS), DEF_BYPASS),
            savepath: storeGet('qbitc_savepath', DEF_SAVEPATH),
            category: storeGet('qbitc_category', DEF_CATEGORY),
            rename: isTrue(storeGet('qbitc_rename', DEF_RENAME), DEF_RENAME),
            confirm: isTrue(storeGet('qbitc_confirm', DEF_CONFIRM), DEF_CONFIRM),
            auto_cat_path: isTrue(storeGet('qbitc_auto_cat_path', DEF_AUTO_CAT_PATH), DEF_AUTO_CAT_PATH),
            player: storeGet('qbitc_player', DEF_PLAYER),
            player_pkg: storeGet('qbitc_player_pkg', DEF_PLAYER_PKG),
            local_prefix: storeGet('qbitc_local_prefix', DEF_LOCAL_PREFIX),
            poll_ms: parseInt(storeGet('qbitc_poll_ms', DEF_POLL_MS), 10) || DEF_POLL_MS,
            show_delete: isTrue(storeGet('qbitc_show_delete', DEF_SHOW_DELETE), DEF_SHOW_DELETE)
        };
    }

    function base() {
        return String(cfg().url || '').replace(/\/+$/, '');
    }

    function joinPath(base, sub) {
        if (!base) return sub || '';
        if (!sub) return base;
        return String(base).replace(/\/+$/, '') + '/' + String(sub).replace(/^\/+/, '');
    }

    function buildAddBody(magnet, title) {
        var c = cfg();
        var body = 'urls=' + encodeURIComponent(magnet);

        var finalSavePath = c.savepath || '';
        var autoTMM = false;

        if (c.auto_cat_path && c.category) {
            if (finalSavePath) {
                finalSavePath = joinPath(finalSavePath, c.category);
            } else {
                autoTMM = true;
            }
        }

        if (finalSavePath) body += '&savepath=' + encodeURIComponent(finalSavePath);
        if (c.category) body += '&category=' + encodeURIComponent(c.category);
        if (c.rename && title) body += '&rename=' + encodeURIComponent(title);

        body += '&paused=false&stopped=false';
        body += '&autoTMM=' + (autoTMM ? 'true' : 'false');

        console.log('[qBittorrent-custom] add body:', body);
        return body;
    }

    function magnetHash(magnet) {
        var m = /urn:btih:([a-zA-Z0-9]+)/.exec(magnet || '');
        return m ? m[1].toLowerCase() : '';
    }

    function nativeRequest(req, cb) {
        var sig = 0;

        function drain() {
            try { AndroidJS.getResp(); } catch (e) {}
        }

        function attempt() {
            if (!window.AndroidJS || typeof AndroidJS.httpReq !== 'function') {
                cb(null);
                return;
            }

            if (sig === 0) {
                try { AndroidJS.httpReq(JSON.stringify(req)); }
                catch (e) { sig++; attempt(); return; }
            } else if (sig === 1) {
                try {
                    AndroidJS.httpReq(
                        req.url,
                        JSON.stringify({ method: req.method, body: req.body || '', headers: req.headers || {} })
                    );
                } catch (e) { cb(null); return; }
            } else {
                cb(null);
                return;
            }

            var tries = 0;

            (function poll() {
                tries++;
                var r = null;
                try { r = AndroidJS.getResp(); } catch (e) {}

                if (typeof r === 'string' && r.length) {
                    cb(r);
                    return;
                }

                if (tries > 14) {
                    sig++;
                    attempt();
                    return;
                }

                setTimeout(poll, 150);
            })();
        }

        drain();
        attempt();
    }

    function blindAdd(magnet, title) {
        if (typeof fetch !== 'function') {
            notify('Не удалось отправить: нет транспорта');
            return;
        }

        fetch(base() + '/api/v2/torrents/add', {
            method: 'POST',
            mode: 'no-cors',
            headers: CT_FORM,
            body: buildAddBody(magnet, title)
        }).then(function () {
            notify('Отправлено в qBittorrent (без подтверждения)');
        }).catch(function (err) {
            console.error('[qBittorrent-custom] blind add error:', err);
            notify('Ошибка отправки в qBittorrent');
        });
    }

    function confirmAdd(magnet, cb) {
        var hash = magnetHash(magnet);
        if (!hash) { cb(false); return; }

        nativeRequest({
            url: base() + '/api/v2/torrents/info?hashes=' + hash,
            method: 'GET'
        }, function (resp) {
            cb(typeof resp === 'string' && resp.toLowerCase().indexOf(hash) !== -1);
        });
    }

    function qbTorrentInfo(hash, cb) {
        if (!hash) { cb(null); return; }

        nativeRequest({
            url: base() + '/api/v2/torrents/info?hashes=' + hash,
            method: 'GET'
        }, function (resp) {
            if (typeof resp !== 'string' || !resp) { cb(null); return; }
            try {
                var arr = JSON.parse(resp);
                cb(arr && arr[0] ? arr[0] : null);
            } catch (e) {
                cb(null);
            }
        });
    }

    function qbAdd(magnet, title, onDone) {
        if (!magnet || !/^magnet:\?/i.test(magnet)) {
            notify('Magnet-ссылка не найдена');
            if (onDone) onDone(false);
            return;
        }

        var c = cfg();
        debugNotify('Отправляю в qBittorrent...');

        var body = buildAddBody(magnet, title);

        function finishAdd(resp) {
            var ok = false;

            if (resp === null || resp === undefined) {
                blindAdd(magnet, title);
                ok = true;
                if (onDone) onDone(ok);
                return;
            }

            console.log('[qBittorrent-custom] add response:', resp);

            if (/Forbidden|403/i.test(resp)) {
                notify('qBittorrent: 403. Включи обход аутентификации для подсети');
                if (onDone) onDone(false);
                return;
            }

            if (/Fails/i.test(resp)) {
                notify('qBittorrent: ошибка добавления');
                if (onDone) onDone(false);
                return;
            }

            ok = true;

            if (c.confirm) {
                confirmAdd(magnet, function (confirmed) {
                    notify(confirmed ? 'Добавлено в qBittorrent ✔' : 'Отправлено в qBittorrent (без подтверждения)');
                    if (onDone) onDone(true);
                });
            } else {
                notify('Отправлено в qBittorrent');
                if (onDone) onDone(true);
            }
        }

        if (!c.bypass && c.user) {
            nativeRequest({
                url: base() + '/api/v2/auth/login',
                method: 'POST',
                body: 'username=' + encodeURIComponent(c.user) + '&password=' + encodeURIComponent(c.pass),
                headers: CT_FORM
            }, function () {
                nativeRequest({
                    url: base() + '/api/v2/torrents/add',
                    method: 'POST',
                    body: body,
                    headers: CT_FORM
                }, finishAdd);
            });
        } else {
            nativeRequest({
                url: base() + '/api/v2/torrents/add',
                method: 'POST',
                body: body,
                headers: CT_FORM
            }, finishAdd);
        }
    }

    function qbDelete(hash, deleteFiles, cb) {
        if (!hash) { if (cb) cb(false); return; }

        var body = 'hashes=' + encodeURIComponent(hash) +
                   '&deleteFiles=' + (deleteFiles ? 'true' : 'false');

        nativeRequest({
            url: base() + '/api/v2/torrents/delete',
            method: 'POST',
            body: body,
            headers: CT_FORM
        }, function (resp) {
            var ok = !(typeof resp === 'string' && /Fails|Forbidden|403/i.test(resp));
            if (cb) cb(ok);
        });
    }

    function toDevicePath(torrent) {
        var c = cfg();
        var serverPath = torrent.content_path || '';

        if (!serverPath) {
            serverPath = joinPath(torrent.save_path || c.savepath || '', torrent.name || '');
        }

        if (!c.local_prefix) return serverPath;

        var baseServer = String(c.savepath || '').replace(/\/+$/, '');
        var rel = serverPath;

        if (baseServer && serverPath.indexOf(baseServer) === 0) {
            rel = serverPath.substring(baseServer.length).replace(/^\/+/, '');
        }

        return joinPath(c.local_prefix, rel);
    }

    function playerIntent(fileUri, title) {
        var c = cfg();
        var pkg = '';
        var mime = 'video/*';

        if (c.player === 'custom') {
            pkg = c.player_pkg || '';
        } else if (PLAYERS[c.player]) {
            pkg = PLAYERS[c.player].pkg;
        }

        var uri = fileUri;

        try {
            if (window.AndroidJS && typeof AndroidJS.openPlayer === 'function') {
                AndroidJS.openPlayer(uri, pkg, title || '', mime);
                return true;
            }
        } catch (e) {
            console.warn('[qBittorrent-custom] AndroidJS.openPlayer failed:', e);
        }

        try {
            if (window.AndroidJS && typeof AndroidJS.startActivity === 'function') {
                AndroidJS.startActivity(JSON.stringify({
                    action: 'android.intent.action.VIEW',
                    data: uri,
                    type: mime,
                    package: pkg,
                    extra: { 'android.intent.extra.TITLE': title || '' }
                }));
                return true;
            }
        } catch (e) {
            console.warn('[qBittorrent-custom] AndroidJS.startActivity failed:', e);
        }

        try {
            var intent = 'intent:' + uri + '#Intent;action=android.intent.action.VIEW;type=' + mime + ';';
            if (pkg) intent += 'package=' + pkg + ';';
            intent += 'end';
            window.location.href = intent;
            return true;
        } catch (e) {
            console.error('[qBittorrent-custom] intent fallback error:', e);
        }

        notify('Не удалось запустить плеер');
        return false;
    }

    function bindPress(el, handler) {
        var last = 0;

        function wrap(ev) {
            var now = Date.now();
            if (now - last < ACTION_LOCK_MS) return;
            last = now;

            if (ev) {
                ev.preventDefault();
                ev.stopPropagation();
                if (ev.stopImmediatePropagation) {
                    ev.stopImmediatePropagation();
                }
            }
            handler(ev);
        }

        el.addEventListener('hover:enter', wrap);
        el.addEventListener('click', wrap);
    }

    // ================= РЕГИСТРАЦИЯ НАСТРОЕК =================

    function registerSettings() {
        try {
            if (!window.Lampa || !Lampa.SettingsApi) {
                console.error('[qBittorrent-custom] Lampa.SettingsApi недоступен');
                return;
            }

            Lampa.SettingsApi.addComponent({
                component: 'qbit_custom',
                icon: '<svg viewBox="0 0 24 24" width="24" height="24"><path fill="currentColor" d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>',
                name: 'qBittorrent custom'
            });

            Lampa.SettingsApi.addParam({
                component: 'qbit_custom',
                param: { name: 'qbitc_url', type: 'input', values: '', default: DEF_URL },
                field: { name: 'Адрес сервера', description: 'Адрес Web UI qBittorrent (например: http://192.168.1.50:8080)' }
            });

            Lampa.SettingsApi.addParam({
                component: 'qbit_custom',
                param: { name: 'qbitc_user', type: 'input', values: '', default: DEF_USER },
                field: { name: 'Логин', description: 'Логин (если не используется обход аутентификации)' }
            });

            Lampa.SettingsApi.addParam({
                component: 'qbit_custom',
                param: { name: 'qbitc_pass', type: 'input', values: '', default: DEF_PASS },
                field: { name: 'Пароль', description: 'Пароль (если не используется обход аутентификации)' }
            });

            Lampa.SettingsApi.addParam({
                component: 'qbit_custom',
                param: { name: 'qbitc_bypass', type: 'trigger', default: DEF_BYPASS },
                field: { name: 'Обход аутентификации', description: 'Включён обход аутентификации для подсети' }
            });

            Lampa.SettingsApi.addParam({
                component: 'qbit_custom',
                param: { name: 'qbitc_savepath', type: 'input', values: '', default: DEF_SAVEPATH },
                field: { name: 'Базовый путь сохранения', description: 'Серверный путь qBittorrent (например: /app/qBittorrent). Пусто = по умолчанию сервера' }
            });

            Lampa.SettingsApi.addParam({
                component: 'qbit_custom',
                param: { name: 'qbitc_category', type: 'input', values: '', default: DEF_CATEGORY },
                field: { name: 'Категория', description: 'Категория для торрентов (например: video)' }
            });

            Lampa.SettingsApi.addParam({
                component: 'qbit_custom',
                param: { name: 'qbitc_auto_cat_path', type: 'trigger', default: DEF_AUTO_CAT_PATH },
                field: {
                    name: 'Автоматически добавлять категорию к пути',
                    description: 'Сохранять торренты в подпапку категории (например, /app/qBittorrent/video). Если путь не задан — включает автоуправление в qBittorrent.'
                }
            });

            Lampa.SettingsApi.addParam({
                component: 'qbit_custom',
                param: { name: 'qbitc_rename', type: 'trigger', default: DEF_RENAME },
                field: { name: 'Переименовывать', description: 'Переименовывать торрент в название раздачи' }
            });

            Lampa.SettingsApi.addParam({
                component: 'qbit_custom',
                param: { name: 'qbitc_confirm', type: 'trigger', default: DEF_CONFIRM },
                field: { name: 'Проверять добавление', description: 'Проверять, что торрент добавился' }
            });

            Lampa.SettingsApi.addParam({
                component: 'qbit_custom',
                param: {
                    name: 'qbitc_player',
                    type: 'select',
                    values: {
                        'vimu':    'Vimu Player',
                        'vlc':     'VLC',
                        'mx':      'MX Player',
                        'kodi':    'Kodi',
                        'just':    'Just (Video) Player',
                        'nplayer': 'nPlayer',
                        'custom':  'Другой (указать пакет)'
                    },
                    default: DEF_PLAYER
                },
                field: {
                    name: 'Медиаплеер',
                    description: 'Плеер, который откроет скачанный торрент по кнопке «Плеер»'
                }
            });

            Lampa.SettingsApi.addParam({
                component: 'qbit_custom',
                param: { name: 'qbitc_player_pkg', type: 'input', values: '', default: DEF_PLAYER_PKG },
                field: {
                    name: 'Пакет плеера (для «Другой»)',
                    description: 'Например: net.gtvbox.videoplayer — используется, если выбран пункт «Другой»'
                }
            });

            Lampa.SettingsApi.addParam({
                component: 'qbit_custom',
                param: { name: 'qbitc_local_prefix', type: 'input', values: '', default: DEF_LOCAL_PREFIX },
                field: {
                    name: 'Путь к загрузкам на устройстве',
                    description: 'Например: smb://192.168.1.50/qBittorrent — серверный путь заменится на этот префикс'
                }
            });

            Lampa.SettingsApi.addParam({
                component: 'qbit_custom',
                param: { name: 'qbitc_show_delete', type: 'trigger', default: DEF_SHOW_DELETE },
                field: { name: 'Кнопка «Удалить»', description: 'Показывать кнопку удаления торрента из qBittorrent после завершения загрузки' }
            });

            console.log('[qBittorrent-custom] Настройки зарегистрированы');
        } catch (e) {
            console.error('[qBittorrent-custom] Ошибка регистрации настроек:', e);
        }
    }

    // ================= ПУНКТ В ГЛАВНОМ МЕНЮ =================

    function addMenuItem() {
        try {
            if (!window.Lampa || !Lampa.Menu || typeof Lampa.Menu.addButton !== 'function') {
                console.error('[qBittorrent-custom] Lampa.Menu.addButton недоступен');
                return;
            }

            var icon = '<svg viewBox="0 0 24 24" width="24" height="24"><path fill="currentColor" d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>';

            Lampa.Menu.addButton(icon, 'qBittorrent', function () {
                Lampa.Controller.toggle('settings');
                setTimeout(function () {
                    var item = document.querySelector('[data-component="qbit_custom"]');
                    if (item) item.click();
                }, 100);
            });

            console.log('[qBittorrent-custom] Пункт меню добавлен');
        } catch (e) {
            console.error('[qBittorrent-custom] Ошибка добавления пункта меню:', e);
        }
    }

    // ================= ОПРОС ПРОГРЕССА =================

    function startProgressWatch(item, hash, title, initialInfo) {
        if (!hash) return;

        var playBtn = item.querySelector('.qbit-player-btn');
        if (!playBtn) return;
        if (playBtn.getAttribute('data-ready') === '1') return;

        var stopped = false;
        var timer = null;
        var tries = 0;
        var MAX_TRIES = 720;

        function cleanup() {
            stopped = true;
            if (timer) { clearTimeout(timer); timer = null; }
        }

        function activate(torrent) {
            if (stopped) return;
            if (playBtn.getAttribute('data-ready') === '1') return;

            playBtn.setAttribute('data-ready', '1');
            playBtn.classList.remove('qbit-player-btn--waiting');
            playBtn.textContent = '▶ Плеер';

            bindPress(playBtn, function () {
                var path = toDevicePath(torrent);
                console.log('[qBittorrent-custom] play path:', path);
                playerIntent(path, title);
            });

            var delBtn = item.querySelector('.qbit-del-btn');
            if (delBtn && delBtn.getAttribute('data-ready') !== '1') {
                delBtn.setAttribute('data-ready', '1');
                delBtn.classList.remove('qbit-player-btn--waiting');
                bindPress(delBtn, function () {
                    notify('Удаляю торрент...');
                    qbDelete(hash, false, function (ok) {
                        notify(ok ? 'Торрент удалён ✔' : 'Не удалось удалить');
                        if (ok) {
                            var btns = item.querySelectorAll('.qbit-direct-btn');
                            for (var i = 0; i < btns.length; i++) btns[i].remove();
                        }
                    });
                });
            }

            cleanup();
        }

        function tick(info) {
            if (stopped) return;

            if (!info) {
                tries++;
                if (tries > MAX_TRIES) { cleanup(); return; }
                timer = setTimeout(function () {
                    qbTorrentInfo(hash, tick);
                }, cfg().poll_ms);
                return;
            }

            var progress = typeof info.progress === 'number' ? info.progress : 0;
            var done = progress >= 1 ||
                       info.state === 'uploading' ||
                       info.state === 'stalledUP' ||
                       info.state === 'pausedUP' ||
                       info.state === 'queuedUP' ||
                       info.state === 'forcedUP';

            if (done) {
                activate(info);
                return;
            }

            tries++;
            if (tries > MAX_TRIES) { cleanup(); return; }

            timer = setTimeout(function () {
                qbTorrentInfo(hash, tick);
            }, cfg().poll_ms);
        }

        tick(initialInfo || null);
    }

    // ================= КНОПКИ В КАРТОЧКЕ ТОРРЕНТА =================

    function initTorrentButton() {
        if (!window.Lampa || !Lampa.Listener) return;

        Lampa.Listener.follow('torrent', function (e) {
            if (!e || e.type !== 'render' || !e.item) return;

            var item = e.item.jquery ? e.item[0] : e.item;
            var data = e.element || {};

            if (!item || item.querySelector('.qbit-direct-btn')) return;

            var magnet = data.MagnetUri || data.magnetUri || '';
            var title  = data.Title || data.title || '';
            var hash   = magnetHash(magnet);
            var c = cfg();

            // --- Кнопка «В qBittorrent» (слева) ---
            var addBtn = document.createElement('div');
            addBtn.className = 'qbit-direct-btn selector';
            addBtn.tabIndex = 0;
            addBtn.textContent = '⬇ В qBittorrent';

            bindPress(addBtn, function () {
                console.log('[qBittorrent-custom] press, magnet:', magnet);
                qbAdd(magnet, title, function (ok) {
                    if (ok && hash) startProgressWatch(item, hash, title);
                });
            });

            // --- Кнопка «Плеер» (справа, пока неактивна) ---
            var playBtn = document.createElement('div');
            playBtn.className = 'qbit-direct-btn qbit-player-btn qbit-player-btn--waiting selector';
            playBtn.tabIndex = 0;
            playBtn.textContent = '▶ Плеер';
            playBtn.setAttribute('data-ready', '0');

            // --- Кнопка «Удалить» (справа, опционально) ---
            var delBtn = null;
            if (c.show_delete) {
                delBtn = document.createElement('div');
                delBtn.className = 'qbit-direct-btn qbit-del-btn qbit-player-btn--waiting selector';
                delBtn.tabIndex = 0;
                delBtn.textContent = '🗑 Удалить';
                delBtn.setAttribute('data-ready', '0');
            }

            // Порядок: qBittorrent → Плеер → Удалить
            item.appendChild(addBtn);
            item.appendChild(playBtn);
            if (delBtn) item.appendChild(delBtn);

            // Если торрент уже есть в qB — сразу проверяем прогресс
            if (hash) {
                qbTorrentInfo(hash, function (info) {
                    if (info) startProgressWatch(item, hash, title, info);
                });
            }
        });
    }

    // ================= ИНИЦИАЛИЗАЦИЯ =================

    function initializePlugin() {
        try {
            console.log('[qBittorrent-custom] Инициализация плагина...');

            registerSettings();
            addMenuItem();
            initTorrentButton();

            if (!document.getElementById('qbitc-style')) {
                var style = document.createElement('style');
                style.id = 'qbitc-style';
                style.textContent =
                    '.qbit-direct-btn{' +
                    'display:inline-flex;align-items:center;' +
                    'justify-content:center;margin:8px;' +
                    'padding:10px 18px;background:#303638;' +
                    'color:white;border:2px solid #888;' +
                    'border-radius:6px;font-size:18px;' +
                    'min-width:160px;box-sizing:border-box;' +
                    'position:relative;z-index:999;' +
                    '}' +
                    '.qbit-direct-btn.focus{' +
                    'border-color:white;background:#51595c;' +
                    '}' +
                    '.qbit-player-btn--waiting{' +
                    'opacity:0.45;' +
                    'border-color:#555;' +
                    '}' +
                    '.qbit-player-btn[data-ready="1"]{' +
                    'border-color:#6a6;' +
                    '}' +
                    '.qbit-player-btn[data-ready="1"].focus{' +
                    'border-color:white;background:#3f6b3f;' +
                    '}' +
                    '.qbit-del-btn[data-ready="1"]{' +
                    'border-color:#a55;' +
                    '}' +
                    '.qbit-del-btn[data-ready="1"].focus{' +
                    'border-color:white;background:#6b3f3f;' +
                    '}';
                document.head.appendChild(style);
            }

            console.log('[qBittorrent-custom] Плагин загружен');
            notify('qBittorrent custom: плагин загружен');
        } catch (error) {
            console.error('[qBittorrent-custom] Ошибка инициализации:', error);
            notify('Ошибка инициализации qBittorrent custom');
        }
    }

    if (window.Lampa && Lampa.Listener) {
        initializePlugin();
    } else {
        document.addEventListener('appready', function () {
            initializePlugin();
        });
    }
})();
