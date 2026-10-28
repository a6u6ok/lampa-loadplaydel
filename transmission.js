(function () {
    'use strict';

    // ===== ЗНАЧЕНИЯ ПО УМОЛЧАНИЮ =====
    var DEF_URL = 'http://192.168.1.50:9091'; // По умолчанию порт Transmission - 9091
    var DEF_USER = '';
    var DEF_PASS = '';
    
    // Для Transmission категорий и путей в API добавления нет,
    // он сохраняет туда, куда настроено в его конфиге (или в настройках ниже).
    
    var DEF_PLAYER = 'vimu';
    var DEF_PLAYER_PKG = '';
    var DEF_LOCAL_PREFIX = 'smb://192.168.1.50/qBittorrent'; // Путь к папке загрузок на устройстве (SMB)
    var DEF_POLL_MS = 5000;
    var DEF_SHOW_DELETE = true;
    // =================================

    var DEBUG = true;
    var ACTION_LOCK_MS = 1000;

    var PLAYERS = {
        'vimu':    { pkg: 'net.gtvbox.videoplayer',   name: 'Vimu Player' },
        'vlc':     { pkg: 'org.videolan.vlc',         name: 'VLC' },
        'mx':      { pkg: 'com.mxtech.videoplayer.ad', name: 'MX Player' },
        'kodi':    { pkg: 'org.xbmc.kodi',            name: 'Kodi' },
        'just':    { pkg: 'com.brouken.player',       name: 'Just (Video) Player' },
        'nplayer': { pkg: 'com.newin.nplayer.pro',    name: 'nPlayer' }
    };

    var sessionId = '';

    function notify(text) {
        try {
            if (window.Lampa && Lampa.Noty) {
                Lampa.Noty.show(text);
                return;
            }
        } catch (e) {}
        console.log('[Transmission]', text);
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

    function isTrue(v, def) {
        if (v === true || v === 'true') return true;
        if (v === false || v === 'false') return false;
        return def;
    }

    function cfg() {
        return {
            url: storeGet('tr_url', DEF_URL),
            user: storeGet('tr_user', DEF_USER),
            pass: storeGet('tr_pass', DEF_PASS),
            player: storeGet('tr_player', DEF_PLAYER),
            player_pkg: storeGet('tr_player_pkg', DEF_PLAYER_PKG),
            local_prefix: storeGet('tr_local_prefix', DEF_LOCAL_PREFIX),
            poll_ms: parseInt(storeGet('tr_poll_ms', DEF_POLL_MS), 10) || DEF_POLL_MS,
            show_delete: isTrue(storeGet('tr_show_delete', DEF_SHOW_DELETE), DEF_SHOW_DELETE)
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

    // Хеш из magnet-ссылки (Base32 / Base16)
    function magnetHash(magnet) {
        var m = /urn:btih:([a-zA-Z0-9]+)/i.exec(magnet || '');
        if (!m) return '';
        var h = m[1];
        if (/^[0-9a-fA-F]{40}$/.test(h)) return h.toLowerCase();
        if (/^[A-Z2-7]{32}$/i.test(h)) {
            try {
                var alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
                var bits = '';
                for (var i = 0; i < h.length; i++) {
                    var idx = alphabet.indexOf(h[i].toUpperCase());
                    if (idx < 0) return '';
                    bits += idx.toString(2).padStart(5, '0');
                }
                var hex = '';
                for (var j = 0; j + 4 <= bits.length; j += 4) {
                    hex += parseInt(bits.substr(j, 4), 2).toString(16);
                }
                return hex.toLowerCase();
            } catch (e) { return ''; }
        }
        return h.toLowerCase();
    }

    // Универсальный запрос к Transmission RPC
    function trRequest(method, args, cb) {
        var c = cfg();
        var data = JSON.stringify({ method: method, arguments: args || {} });
        
        var headers = { 'Content-Type': 'application/json' };
        if (sessionId) {
            headers['X-Transmission-Session-Id'] = sessionId;
        }
        if (c.user) {
            headers['Authorization'] = 'Basic ' + btoa(c.user + ':' + c.pass);
        }

        // Если нативный мост не работает или ломается, используем fetch
        // (Transmission обычно отдает CORS нормально, в отличие от qBittorrent)
        function doFetch() {
            fetch(base() + '/transmission/rpc', {
                method: 'POST',
                headers: headers,
                body: data
            }).then(function (res) {
                // Перехватываем ID сессии
                if (res.status === 409 || res.headers.has('X-Transmission-Session-Id')) {
                    var sid = res.headers.get('X-Transmission-Session-Id');
                    if (sid) sessionId = sid;
                    
                    // Если это 409, нужно повторить запрос с новым ID
                    if (res.status === 409) {
                        return trRequest(method, args, cb);
                    }
                }
                if (!res.ok) throw new Error('HTTP ' + res.status);
                return res.json();
            }).then(function (json) {
                if (json && json.result === 'success') {
                    cb(true, json.arguments);
                } else {
                    console.warn('[Transmission] RPC Error:', json);
                    cb(false, json);
                }
            }).catch(function (err) {
                console.warn('[Transmission] fetch error:', err);
                cb(false, null);
            });
        }

        if (!window.AndroidJS || typeof AndroidJS.httpReq !== 'function') {
            doFetch();
            return;
        }

        // Пытаемся использовать нативный AndroidJS (с фоллбэком на fetch)
        try {
            AndroidJS.httpReq(
                base() + '/transmission/rpc',
                JSON.stringify({ method: 'POST', body: data, headers: headers })
            );
        } catch (e) {
            doFetch();
            return;
        }

        var tries = 0;
        (function poll() {
            tries++;
            var r = null;
            try { r = AndroidJS.getResp(); } catch (e) {}

            if (typeof r === 'string' && r.length > 2) {
                try {
                    var json = JSON.parse(r);
                    cb(json.result === 'success', json.arguments);
                } catch (e) {
                    doFetch(); // Если пришел мусор, пробуем fetch
                }
                return;
            }
            if (tries > 10) {
                doFetch();
                return;
            }
            setTimeout(poll, 200);
        })();
    }

    function trAdd(magnet, title, onDone) {
        if (!magnet || !/^magnet:\?/i.test(magnet)) {
            notify('Magnet-ссылка не найдена');
            if (onDone) onDone(false);
            return;
        }

        notify('Отправляю в Transmission...');
        
        trRequest('torrent-add', { filename: magnet }, function (ok, args) {
            if (ok) {
                notify('Добавлено в Transmission ✔');
                if (onDone) onDone(true, args);
            } else {
                notify('Ошибка добавления в Transmission');
                if (onDone) onDone(false);
            }
        });
    }

    function trTorrentInfo(hash, cb) {
        if (!hash) { cb(null); return; }
        
        trRequest('torrent-get', { 
            ids: [ hash ], 
            fields: [ 'id', 'hashString', 'name', 'percentDone', 'status', 'downloadDir', 'totalSize', 'files' ] 
        }, function (ok, args) {
            if (ok && args && args.torrents && args.torrents.length > 0) {
                cb(args.torrents[0]);
            } else {
                cb(null);
            }
        });
    }

    function trDelete(hash, deleteFiles, cb) {
        if (!hash) { if (cb) cb(false); return; }
        
        trRequest('torrent-remove', { 
            ids: [ hash ], 
            'delete-local-data': deleteFiles 
        }, function (ok) {
            if (cb) cb(ok);
        });
    }

    // Формирование пути для плеера
    function toDevicePath(torrent) {
        var c = cfg();
        // В Transmission нет content_path, есть downloadDir (папка загрузки) и name (название)
        var serverPath = joinPath(torrent.downloadDir || '', torrent.name || '');
        
        if (!c.local_prefix) return serverPath;

        // Заменяем серверный путь на локальный (SMB)
        // Если downloadDir равен /opt/share/Downloads, а local_prefix = smb://192.168.1.50/qBittorrent
        // То путь будет smb://192.168.1.50/qBittorrent/Название раздачи
        return joinPath(c.local_prefix, torrent.name || '');
    }

    function playerIntent(fileUri, title) {
        var c = cfg();
        var pkg = '';
        var mime = 'video/*';

        if (c.player === 'custom') pkg = c.player_pkg || '';
        else if (PLAYERS[c.player]) pkg = PLAYERS[c.player].pkg;

        var uri = fileUri;

        try {
            if (window.AndroidJS && typeof AndroidJS.openPlayer === 'function') {
                AndroidJS.openPlayer(uri, pkg, title || '', mime);
                return true;
            }
        } catch (e) {}

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
        } catch (e) {}

        try {
            var intent = 'intent:' + uri + '#Intent;action=android.intent.action.VIEW;type=' + mime + ';';
            if (pkg) intent += 'package=' + pkg + ';';
            intent += 'end';
            window.location.href = intent;
            return true;
        } catch (e) {}

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
                if (ev.stopImmediatePropagation) ev.stopImmediatePropagation();
            }
            handler(ev);
        }
        el.addEventListener('hover:enter', wrap);
        el.addEventListener('click', wrap);
    }

    // ================= НАСТРОЙКИ =================
    function registerSettings() {
        try {
            if (!window.Lampa || !Lampa.SettingsApi) return;
            
            Lampa.SettingsApi.addComponent({
                component: 'tr_client',
                icon: '<svg viewBox="0 0 24 24" width="24" height="24"><path fill="currentColor" d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 14H9V8h2v8zm4 0h-2V8h2v8z"/></svg>',
                name: 'Transmission'
            });

            Lampa.SettingsApi.addParam({ component: 'tr_client', param: { name: 'tr_url', type: 'input', values: '', default: DEF_URL }, field: { name: 'Адрес сервера', description: 'http://192.168.1.50:9091' }});
            Lampa.SettingsApi.addParam({ component: 'tr_client', param: { name: 'tr_user', type: 'input', values: '', default: DEF_USER }, field: { name: 'Логин', description: 'Логин RPC (если включена авторизация)' }});
            Lampa.SettingsApi.addParam({ component: 'tr_client', param: { name: 'tr_pass', type: 'input', values: '', default: DEF_PASS }, field: { name: 'Пароль', description: 'Пароль RPC' }});
            
            Lampa.SettingsApi.addParam({ component: 'tr_client', param: { name: 'tr_player', type: 'select', values: {'vimu': 'Vimu Player', 'vlc': 'VLC', 'mx': 'MX Player', 'kodi': 'Kodi', 'just': 'Just (Video) Player', 'nplayer': 'nPlayer', 'custom': 'Другой'}, default: DEF_PLAYER }, field: { name: 'Медиаплеер', description: 'Для открытия торрента' }});
            Lampa.SettingsApi.addParam({ component: 'tr_client', param: { name: 'tr_player_pkg', type: 'input', values: '', default: DEF_PLAYER_PKG }, field: { name: 'Пакет плеера', description: 'Для пункта «Другой»' }});
            
            Lampa.SettingsApi.addParam({ component: 'tr_client', param: { name: 'tr_local_prefix', type: 'input', values: '', default: DEF_LOCAL_PREFIX }, field: { name: 'Путь к загрузкам', description: 'smb://192.168.1.50/qBittorrent (куда смотрит Vimu)' }});
            Lampa.SettingsApi.addParam({ component: 'tr_client', param: { name: 'tr_show_delete', type: 'trigger', default: DEF_SHOW_DELETE }, field: { name: 'Кнопка «Удалить»', description: 'Показывать кнопку удаления' }});
            
        } catch (e) {
            console.error('[Transmission] Ошибка настроек:', e);
        }
    }

    function addMenuItem() {
        try {
            if (!window.Lampa || !Lampa.Menu) return;
            var icon = '<svg viewBox="0 0 24 24" width="24" height="24"><path fill="currentColor" d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>';
            Lampa.Menu.addButton(icon, 'Transmission', function () {
                Lampa.Controller.toggle('settings');
                setTimeout(function () {
                    var item = document.querySelector('[data-component="tr_client"]');
                    if (item) item.click();
                }, 100);
            });
        } catch (e) {}
    }

    function startProgressWatch(item, hash, title, initialInfo) {
        if (!hash) return;
        var playBtn = item.querySelector('.tr-player-btn');
        if (!playBtn || playBtn.getAttribute('data-ready') === '1') return;

        var stopped = false, timer = null, tries = 0, MAX_TRIES = 720;

        function cleanup() { stopped = true; if (timer) { clearTimeout(timer); timer = null; } }

        function activate(torrent) {
            if (stopped || playBtn.getAttribute('data-ready') === '1') return;
            playBtn.setAttribute('data-ready', '1');
            playBtn.classList.remove('tr-btn--waiting');
            playBtn.textContent = '▶ Плеер';

            bindPress(playBtn, function () {
                var path = toDevicePath(torrent);
                playerIntent(path, title);
            });

            var delBtn = item.querySelector('.tr-del-btn');
            if (delBtn && delBtn.getAttribute('data-ready') !== '1') {
                delBtn.setAttribute('data-ready', '1');
                delBtn.classList.remove('tr-btn--waiting');
                bindPress(delBtn, function () {
                    notify('Удаляю торрент...');
                    trDelete(hash, false, function (ok) {
                        notify(ok ? 'Торрент удалён ✔' : 'Не удалось удалить');
                        if (ok) {
                            var btns = item.querySelectorAll('.tr-direct-btn');
                            for (var i = 0; i < btns.length; i++) btns[i].remove();
                        }
                    });
                });
            }
            cleanup();
        }

        function tick(torrent) {
            if (stopped) return;
            if (!torrent) {
                tries++;
                if (tries > MAX_TRIES) { cleanup(); return; }
                timer = setTimeout(function () { trTorrentInfo(hash, tick); }, cfg().poll_ms);
                return;
            }

            // В Transmission: status 6 = Seeding (Раздача, т.е. скачан), 0 = Stopped, 4 = Downloading
            var progress = typeof torrent.percentDone === 'number' ? torrent.percentDone : 0;
            var done = progress >= 1 || torrent.status === 6 || torrent.status === 5 || torrent.status === 1;

            if (done) { activate(torrent); return; }

            tries++;
            if (tries > MAX_TRIES) { cleanup(); return; }
            timer = setTimeout(function () { trTorrentInfo(hash, tick); }, cfg().poll_ms);
        }

        tick(initialInfo || null);
    }

    function initTorrentButton() {
        if (!window.Lampa || !Lampa.Listener) return;

        Lampa.Listener.follow('torrent', function (e) {
            if (!e || e.type !== 'render' || !e.item) return;

            var item = e.item.jquery ? e.item[0] : e.item;
            var data = e.element || {};
            if (!item || item.querySelector('.tr-direct-btn')) return;

            var magnet = data.MagnetUri || data.magnetUri || '';
            var title  = data.Title || data.title || '';
            var hash   = magnetHash(magnet);
            var c = cfg();

            var addBtn = document.createElement('div');
            addBtn.className = 'tr-direct-btn selector';
            addBtn.tabIndex = 0;
            addBtn.textContent = '⬇ В Transmission';
            
            bindPress(addBtn, function () {
                trAdd(magnet, title, function (ok) {
                    if (hash) startProgressWatch(item, hash, title);
                });
            });

            var playBtn = document.createElement('div');
            playBtn.className = 'tr-direct-btn tr-player-btn tr-btn--waiting selector';
            playBtn.tabIndex = 0;
            playBtn.textContent = '▶ Плеер';
            playBtn.setAttribute('data-ready', '0');

            var delBtn = null;
            if (c.show_delete) {
                delBtn = document.createElement('div');
                delBtn.className = 'tr-direct-btn tr-del-btn tr-btn--waiting selector';
                delBtn.tabIndex = 0;
                delBtn.textContent = '🗑 Удалить';
                delBtn.setAttribute('data-ready', '0');
            }

            item.appendChild(addBtn);
            item.appendChild(playBtn);
            if (delBtn) item.appendChild(delBtn);

            if (hash) {
                trTorrentInfo(hash, function (torrent) {
                    if (torrent) startProgressWatch(item, hash, title, torrent);
                });
            }
        });
    }

    function initializePlugin() {
        try {
            registerSettings();
            addMenuItem();
            initTorrentButton();

            if (!document.getElementById('tr-style')) {
                var style = document.createElement('style');
                style.id = 'tr-style';
                style.textContent =
                    '.tr-direct-btn{display:inline-flex;align-items:center;justify-content:center;margin:8px;padding:10px 18px;background:#303638;color:white;border:2px solid #888;border-radius:6px;font-size:18px;min-width:160px;box-sizing:border-box;position:relative;z-index:999;}' +
                    '.tr-direct-btn.focus{border-color:white;background:#51595c;}' +
                    '.tr-btn--waiting{opacity:0.45;border-color:#555;}' +
                    '.tr-player-btn[data-ready="1"]{border-color:#6a6;}' +
                    '.tr-player-btn[data-ready="1"].focus{border-color:white;background:#3f6b3f;}' +
                    '.tr-del-btn[data-ready="1"]{border-color:#a55;}' +
                    '.tr-del-btn[data-ready="1"].focus{border-color:white;background:#6b3f3f;}';
                document.head.appendChild(style);
            }
        } catch (error) {
            console.error('[Transmission] Ошибка инициализации:', error);
        }
    }

    if (window.Lampa && Lampa.Listener) {
        initializePlugin();
    } else {
        document.addEventListener('appready', function () { initializePlugin(); });
    }
})();
