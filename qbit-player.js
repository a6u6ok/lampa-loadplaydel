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
    // =================================

    var DEBUG = true;
    var ACTION_LOCK_MS = 1000;
    var CT_FORM = { 'Content-Type': 'application/x-www-form-urlencoded' };

    // Карта известных плееров: ключ -> { pkg, name }
    var PLAYERS = {
        'vimu':   { pkg: 'net.gtvbox.videoplayer',        name: 'Vimu Player' },
        'vlc':    { pkg: 'org.videolan.vlc',               name: 'VLC' },
        'mx':     { pkg: 'com.mxtech.videoplayer.ad',      name: 'MX Player' },
        'kodi':   { pkg: 'org.xbmc.kodi',                  name: 'Kodi' },
        'just':   { pkg: 'com.brouken.player',             name: 'Just (Video) Player' },
        'nplayer':{ pkg: 'com.newin.nplayer.pro',          name: 'nPlayer' }
    };

    function notify(text) {
        try {
            if (window.Lampa && Lampa.Noty) {
                Lampa.Noty.show(text);
                return;
            }
        } catch (e) {
            console.warn('[qBittorrent] notify error:', e);
        }
        console.log('[qBittorrent]', text);
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
            url: storeGet('qbit_url', DEF_URL),
            user: storeGet('qbit_user', DEF_USER),
            pass: storeGet('qbit_pass', DEF_PASS),
            bypass: isTrue(storeGet('qbit_bypass', DEF_BYPASS), DEF_BYPASS),
            savepath: storeGet('qbit_savepath', DEF_SAVEPATH),
            category: storeGet('qbit_category', DEF_CATEGORY),
            rename: isTrue(storeGet('qbit_rename', DEF_RENAME), DEF_RENAME),
            confirm: isTrue(storeGet('qbit_confirm', DEF_CONFIRM), DEF_CONFIRM),
            auto_cat_path: isTrue(storeGet('qbit_auto_cat_path', DEF_AUTO_CAT_PATH), DEF_AUTO_CAT_PATH),
            player: storeGet('qbit_player', DEF_PLAYER),
            player_pkg: storeGet('qbit_player_pkg', DEF_PLAYER_PKG),
            local_prefix: storeGet('qbit_local_prefix', DEF_LOCAL_PREFIX),
            poll_ms: parseInt(storeGet('qbit_poll_ms', DEF_POLL_MS), 10) || DEF_POLL_MS
        };
    }

    function base() {
        return String(cfg().url || '').replace(/\/+$/, '');
    }

    // Корректно объединяет части пути, убирая лишние слэши.
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

        console.log('[qBittorrent] add body:', body);
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
            console.error('[qBittorrent] blind add error:', err);
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

    // Возвращает объект torrent из qB по хешу или null.
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

            console.log('[qBittorrent] add response:', resp);

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

    // Преобразует серверный путь qBittorrent в SMB/локальный путь для плеера.
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

    // Запуск плеера через Android intent. Vimu / VLC / MX / Kodi умеют smb://
    function playerIntent(fileUri, title) {
        var c = cfg();
        var pkg = '';
        var mime = 'video/*';

        if (c.player === 'custom') {
            pkg = c.player_pkg || '';
        } else if (PLAYERS[c.player]) {
            pkg = PLAYERS[c.player].pkg;
        }

        // Vimu часто ждёт не percent-encoded URI; отдаём как есть.
        var uri = fileUri;

        try {
            if (window.AndroidJS && typeof AndroidJS.openPlayer === 'function') {
                AndroidJS.openPlayer(uri, pkg, title || '', mime);
                return true;
            }
        } catch (e) {
            console.warn('[qBittorrent] AndroidJS.openPlayer failed:', e);
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
            console.warn('[qBittorrent] AndroidJS.startActivity failed:', e);
        }

        try {
            var intent = 'intent:' + uri + '#Intent;action=android.intent.action.VIEW;type=' + mime + ';';
            if (pkg) intent += 'package=' + pkg + ';';
            intent += 'end';
            window.location.href = intent;
            return true;
        } catch (e) {
            console.error('[qBittorrent] intent fallback error:', e);
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
                console.error('[qBittorrent] Lampa.SettingsApi недоступен');
                return;
            }

            Lampa.SettingsApi.addComponent({
                component: 'qbit_direct',
                icon: '<svg viewBox="0 0 24 24" width="24" height="24"><path fill="currentColor" d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>',
                name: 'qBittorrent'
            });

            Lampa.SettingsApi.addParam({
                component: 'qbit_direct',
                param: { name: 'qbit_url', type: 'input', values: '', default: DEF_URL },
                field: { name: 'Адрес сервера', description: 'Адрес Web UI qBittorrent (например: http://192.168.1.50:8080)' }
            });

            Lampa.SettingsApi.addParam({
                component: 'qbit_direct',
                param: { name: 'qbit_user', type: 'input', values: '', default: DEF_USER },
                field: { name: 'Логин', description: 'Логин (если не используется обход аутентификации)' }
            });

            Lampa.SettingsApi.addParam({
                component: 'qbit_direct',
                param: { name: 'qbit_pass', type: 'input', values: '', default: DEF_PASS },
                field: { name: 'Пароль', description: 'Пароль (если не используется обход аутентификации)' }
            });

            Lampa.SettingsApi.addParam({
                component: 'qbit_direct',
                param: { name: 'qbit_bypass', type: 'trigger', default: DEF_BYPASS },
                field: { name: 'Обход аутентификации', description: 'Включён обход аутентификации для подсети' }
            });

            Lampa.SettingsApi.addParam({
                component: 'qbit_direct',
                param: { name: 'qbit_savepath', type: 'input', values: '', default: DEF_SAVEPATH },
                field: { name: 'Базовый путь сохранения', description: 'Серверный путь qBittorrent (например: /app/qBittorrent). Пусто = по умолчанию сервера' }
            });

            Lampa.SettingsApi.addParam({
                component: 'qbit_direct',
                param: { name: 'qbit_category', type: 'input', values: '', default: DEF_CATEGORY },
                field: { name: 'Категория', description: 'Категория для торрентов (например: video)' }
            });

            Lampa.SettingsApi.addParam({
                component: 'qbit_direct',
                param: { name: 'qbit_auto_cat_path', type: 'trigger', default: DEF_AUTO_CAT_PATH },
                field: {
                    name: 'Автоматически добавлять категорию к пути',
                    description: 'Сохранять торренты в подпапку категории (например, /app/qBittorrent/video). Если путь не задан — включает автоуправление в qBittorrent.'
                }
            });

            Lampa.SettingsApi.addParam({
                component: 'qbit_direct',
                param: { name: 'qbit_rename', type: 'trigger', default: DEF_RENAME },
                field: { name: 'Переименовывать', description: 'Переименовывать торрент в название раздачи' }
            });

            Lampa.SettingsApi.addParam({
                component: 'qbit_direct',
                param: { name: 'qbit_confirm', type: 'trigger', default: DEF_CONFIRM },
                field: { name: 'Проверять добавление', description: 'Проверять, что торрент добавился' }
            });

            // ===== Плеер =====

            Lampa.SettingsApi.addParam({
                component: 'qbit_direct',
                param: {
                    name: 'qbit_player',
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
                component: 'qbit_direct',
                param: { name: 'qbit_player_pkg', type: 'input', values: '', default: DEF_PLAYER_PKG },
                field: {
                    name: 'Пакет плеера (для «Другой»)',
                    description: 'Например: net.gtvbox.videoplayer — используется, если выбран пункт «Другой»'
                }
            });

            Lampa.SettingsApi.addParam({
                component: 'qbit_direct',
                param: { name: 'qbit_local_prefix', type: 'input', values: '', default: DEF_LOCAL_PREFIX },
                field: {
                    name: 'Путь к загрузкам на устройстве',
                    description: 'Например: smb://192.168.1.50/qBittorrent — серверный путь заменится на этот префикс'
                }
            });

            console.log('[qBittorrent] Настройки зарегистрированы');
        } catch (e) {
            console.error('[qBittorrent] Ошибка регистрации настроек:', e);
        }
    }

    // ================= ПУНКТ В ГЛАВНОМ МЕНЮ =================

    function addMenuItem() {
        try {
            if (!window.Lampa || !Lampa.Menu || typeof Lampa.Menu.addButton !== 'function') {
                console.error('[qBittorrent] Lampa.Menu.addButton недоступен');
                return;
            }

            var icon = '<svg viewBox="0 0 24 24" width="24" height="24"><path fill="currentColor" d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>';

            Lampa.Menu.addButton(icon, 'qBittorrent', function () {
                Lampa.Controller.toggle('settings');
                setTimeout(function () {
                    var item = document.querySelector('[data-component="qbit_direct"]');
                    if (item) item.click();
                }, 100);
            });

            console.log('[qBittorrent] Пункт меню добавлен');
        } catch (e) {
            console.error('[qBittorrent] Ошибка добавления пункта меню:', e);
        }
    }

    // ================= КНОПКИ В КАРТОЧКЕ ТОРРЕНТА =================

    function startProgressWatch(item, hash, title, initialInfo) {
        if (!hash) return;
        if (item.querySelector('.qbit-player-btn')) return;

        var stopped = false;
        var timer = null;
        var tries = 0;
        var MAX_TRIES = 720; // ~1 час при poll 5с

        function cleanup() {
            stopped = true;
            if (timer) { clearTimeout(timer); timer = null; }
        }

        function showPlayerButton(torrent) {
            if (stopped || item.querySelector('.qbit-player-btn')) return;

            var playBtn = document.createElement('div');
            playBtn.className = 'qbit-player-btn selector';
            playBtn.tabIndex = 0;
            playBtn.textContent = '▶ Плеер';

            bindPress(playBtn, function () {
                var path = toDevicePath(torrent);
                console.log('[qBittorrent] play path:', path);
                playerIntent(path, title);
            });

            var addBtn = item.querySelector('.qbit-direct-btn');
            if (addBtn && addBtn.parentNode) {
                addBtn.parentNode.insertBefore(playBtn, addBtn.nextSibling);
            } else {
                item.appendChild(playBtn);
            }
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
                showPlayerButton(info);
                cleanup();
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

            var addBtn = document.createElement('div');
            addBtn.className = 'qbit-direct-btn selector';
            addBtn.tabIndex = 0;
            addBtn.textContent = '⬇ В qBittorrent';

            bindPress(addBtn, function () {
                console.log('[qBittorrent] press, magnet:', magnet);
                qbAdd(magnet, title, function (ok) {
                    if (ok && hash) startProgressWatch(item, hash, title);
                });
            });

            item.appendChild(addBtn);

            // Если торрент уже есть в qB — сразу начинаем следить за прогрессом
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
            console.log('[qBittorrent] Инициализация плагина...');

            registerSettings();
            addMenuItem();
            initTorrentButton();

            if (!document.getElementById('qbit-direct-style')) {
                var style = document.createElement('style');
                style.id = 'qbit-direct-style';
                style.textContent =
                    '.qbit-direct-btn{' +
                    'display:inline-flex;align-items:center;' +
                    'justify-content:center;margin:8px;' +
                    'padding:10px 18px;background:#303638;' +
                    'color:white;border:2px solid #888;' +
                    'border-radius:6px;font-size:18px;' +
                    'position:relative;z-index:999;' +
                    '}' +
                    '.qbit-direct-btn.focus{' +
                    'border-color:white;background:#51595c;' +
                    '}' +
                    '.qbit-player-btn{' +
                    'display:inline-flex;align-items:center;' +
                    'justify-content:center;margin:8px;' +
                    'padding:10px 18px;background:#2e4a2e;' +
                    'color:white;border:2px solid #6a6;' +
                    'border-radius:6px;font-size:18px;' +
                    'position:relative;z-index:999;' +
                    '}' +
                    '.qbit-player-btn.focus{' +
                    'border-color:white;background:#3f6b3f;' +
                    '}';
                document.head.appendChild(style);
            }

            console.log('[qBittorrent] Плагин загружен');
            notify('qBittorrent: плагин загружен');
        } catch (error) {
            console.error('[qBittorrent] Ошибка инициализации:', error);
            notify('Ошибка инициализации qBittorrent');
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
