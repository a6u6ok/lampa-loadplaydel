(function () {
    'use strict';

    // ================= ЗНАЧЕНИЯ ПО УМОЛЧАНИЮ =================

    var DEF_URL = 'http://192.168.1.50:8090';
    var DEF_SAVETODB = false;
    var DEF_ALWAYS_SHOW = false;
    var DEF_TIMEOUT = 60000;

    var DEBUG = true;
    var ACTION_LOCK_MS = 800;
    var POLL_INTERVAL = 3000;

    var CT_JSON = { 'Content-Type': 'application/json' };

    // ================= УТИЛИТЫ =================

    function notify(text) {
        try {
            if (window.Lampa && Lampa.Noty) { Lampa.Noty.show(text); return; }
        } catch (e) { console.error('[TorrServer] notify:', e); }
        console.log('[TorrServer]', text);
    }

    function debugNotify(text) { if (DEBUG) notify(text); }

    function storeGet(key, defaultValue) {
        try {
            if (window.Lampa && Lampa.Storage) {
                var v = Lampa.Storage.get(key, defaultValue);
                if (v !== undefined && v !== null) return v;
            }
        } catch (e) { console.error('[TorrServer] storeGet:', e); }
        return defaultValue;
    }

    function isTrue(value, defaultValue) {
        if (value === true || value === 'true') return true;
        if (value === false || value === 'false') return false;
        return defaultValue;
    }

    function cfg() {
        return {
            url: storeGet('ts_url', DEF_URL),
            savetodb: isTrue(storeGet('ts_savetodb', DEF_SAVETODB), DEF_SAVETODB),
            always_show: isTrue(storeGet('ts_always_show', DEF_ALWAYS_SHOW), DEF_ALWAYS_SHOW),
            timeout: parseInt(storeGet('ts_timeout', DEF_TIMEOUT), 10) || DEF_TIMEOUT
        };
    }

    function base() { return String(cfg().url || '').replace(/\/+$/, ''); }

    function magnetHash(magnet) {
        var m = /urn:btih:([a-zA-Z0-9]+)/.exec(magnet || '');
        return m ? m[1].toLowerCase() : '';
    }

    // ================= HTTP ЗАПРОСЫ =================

    function nativeRequest(request, callback) {
        var responded = false;

        function finish(response) {
            if (responded) return;
            responded = true;
            if (response === null || response === undefined) {
                fetchRequest(request, callback);
                return;
            }
            callback(response);
        }

        if (!window.AndroidJS || typeof AndroidJS.httpReq !== 'function') {
            fetchRequest(request, callback);
            return;
        }

        try { AndroidJS.getResp(); } catch (e) { console.error('[TorrServer] getResp drain:', e); }

        try { AndroidJS.httpReq(JSON.stringify(request)); }
        catch (e) {
            console.error('[TorrServer] httpReq(json):', e);
            try {
                AndroidJS.httpReq(request.url, JSON.stringify({
                    method: request.method, body: request.body || '', headers: request.headers || {}
                }));
            } catch (e2) {
                console.error('[TorrServer] httpReq(url,json):', e2);
                fetchRequest(request, callback);
                return;
            }
        }

        var tries = 0, maxTries = 20;
        (function poll() {
            if (responded) return;
            tries++;
            var response = null;
            try { response = AndroidJS.getResp(); } catch (e) { console.error('[TorrServer] getResp:', e); }

            if (typeof response === 'string' && response.length > 2) { finish(response); return; }
            if (tries >= maxTries) { console.warn('[TorrServer] timeout'); finish(null); return; }
            setTimeout(poll, 150);
        })();
    }

    function fetchRequest(request, callback) {
        if (typeof fetch !== 'function') { callback(null); return; }
        var opts = {
            method: request.method || 'GET',
            headers: request.headers || CT_JSON,
            credentials: 'include'
        };
        if (request.body) opts.body = request.body;

        fetch(request.url, opts)
            .then(function (r) { return r.text(); })
            .then(function (t) { callback(t); })
            .catch(function (e) { console.error('[TorrServer] fetch:', e); callback(null); });
    }

    // ================= TORRSERVER =================

    function tsAdd(magnet, title, onComplete) {
        if (!magnet || !/^magnet:\?/i.test(magnet)) {
            console.warn('[TorrServer] Magnet не найден или неверен');
            return;
        }

        var config = cfg();
        var payload = JSON.stringify({
            action: 'add',
            link: magnet,
            title: title || '',
            save_to_db: config.savetodb
        });

        debugNotify('Отправляю в TorrServer...');

        nativeRequest({
            url: base() + '/torrents',
            method: 'POST',
            body: payload,
            headers: CT_JSON
        }, function (response) {
            console.log('[TorrServer] add response:', response);
            if (response === null) return;

            try {
                var data = JSON.parse(response);
                if (data && (data.hash || data.Hash)) {
                    notify('Отправлено в TorrServer');
                    if (onComplete) onComplete(data.hash || data.Hash);
                    return;
                }
            } catch (e) { console.error('[TorrServer] parse add:', e); }

            console.error('[TorrServer] add failed');
        });
    }

    function tsCheck(hash, callback) {
        if (!hash) return;

        nativeRequest({
            url: base() + '/torrents',
            method: 'POST',
            body: JSON.stringify({ action: 'get', hash: hash }),
            headers: CT_JSON
        }, function (response) {
            if (typeof response !== 'string' || !response.length) return;
            try {
                var data = JSON.parse(response);
                // TorrServer возвращает поле Stat (0-100) или loaded_size/torrent_size
                var stat = 0;
                if (typeof data.Stat === 'number') stat = data.Stat;
                else if (data.Stat === undefined && typeof data.Progress === 'number') stat = data.Progress * 100;
                else if (data.TorrentSize && data.LoadedSize) stat = Math.round((data.LoadedSize / data.TorrentSize) * 100);
                callback(Math.max(0, Math.min(100, stat)));
            } catch (e) { console.error('[TorrServer] parse get:', e); }
        });
    }

    // ================= НАЖАТИЯ =================

    function bindPress(element, handler) {
        var last = 0;
        function wrapped(event) {
            var now = Date.now();
            if (now - last < ACTION_LOCK_MS) return;
            last = now;
            if (event) {
                event.preventDefault();
                event.stopPropagation();
                if (event.stopImmediatePropagation) event.stopImmediatePropagation();
            }
            handler(event);
        }
        element.addEventListener('hover:enter', wrapped);
        element.addEventListener('click', wrapped);
    }

    // ================= РЕГИСТРАЦИЯ НАСТРОЕК =================

    function registerSettings() {
        try {
            if (!window.Lampa || !Lampa.SettingsApi) return;

            Lampa.SettingsApi.addComponent({
                component: 'torrserver_direct',
                icon: '<svg viewBox="0 0 24 24" width="24" height="24"><path fill="currentColor" d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 14H9V8h2v8zm4 0h-2V8h2v8z"/></svg>',
                name: 'TorrServer'
            });

            Lampa.SettingsApi.addParam({
                component: 'torrserver_direct',
                param: { name: 'ts_url', type: 'input', values: '', default: DEF_URL },
                field: { name: 'Адрес TorrServer', description: 'http://192.168.1.50:8090' }
            });

            Lampa.SettingsApi.addParam({
                component: 'torrserver_direct',
                param: { name: 'ts_savetodb', type: 'trigger', default: DEF_SAVETODB },
                field: { name: 'Сохранять в базу TorrServer', description: 'Не терять после перезапуска' }
            });

            Lampa.SettingsApi.addParam({
                component: 'torrserver_direct',
                param: { name: 'ts_always_show', type: 'trigger', default: DEF_ALWAYS_SHOW },
                field: { name: 'Всегда показывать прогресс', description: 'Не скрывать кнопку после 100%' }
            });

            Lampa.SettingsApi.addParam({
                component: 'torrserver_direct',
                param: { name: 'ts_timeout', type: 'input', values: '', default: DEF_TIMEOUT },
                field: { name: 'Таймаут запроса (мс)', description: '60000' }
            });

            console.log('[TorrServer] Настройки зарегистрированы');
        } catch (e) { console.error('[TorrServer] registerSettings:', e); }
    }

    // ================= ПУНКТ МЕНЮ =================

    function addMenuItem() {
        try {
            if (!window.Lampa || !Lampa.Menu || typeof Lampa.Menu.addButton !== 'function') return;

            var icon = '<svg viewBox="0 0 24 24" width="24" height="24"><path fill="currentColor" d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 14H9V8h2v8zm4 0h-2V8h2v8z"/></svg>';

            Lampa.Menu.addButton(icon, 'TorrServer', function () {
                Lampa.Controller.toggle('settings');
                setTimeout(function () {
                    var item = document.querySelector('[data-component="torrserver_direct"]');
                    if (item) item.click();
                }, 100);
            });
        } catch (e) { console.error('[TorrServer] addMenuItem:', e); }
    }

    // ================= КНОПКИ В КАРТОЧКЕ =================

    function createButton(className, text, handler) {
        var button = document.createElement('div');
        button.className = 'ts-direct-btn ' + className + ' selector';
        button.tabIndex = 0;
        button.textContent = text;
        bindPress(button, handler);
        return button;
    }

    function initTorrentButton() {
        if (!window.Lampa || !Lampa.Listener) return;

        Lampa.Listener.follow('torrent', function (event) {
            if (!event || event.type !== 'render' || !event.item) return;

            var item = event.item.jquery ? event.item[0] : event.item;
            var data = event.element || {};

            if (!item || item.querySelector('.ts-direct-btn')) return;

            var magnet = data.MagnetUri || data.magnetUri || '';
            var title = data.Title || data.title || '';
            var hash = magnetHash(magnet);

            if (!hash) return;

            var config = cfg();

            var preloadButton = createButton('ts-direct-preload', '⬇ Предзагрузка', function () {
                preloadButton.textContent = '⏳ 0%';
                preloadButton.classList.add('ts-loading');

                tsAdd(magnet, title, function (serverHash) {
                    var pollTimer = setInterval(function () {
                        if (!document.body.contains(item)) { clearInterval(pollTimer); return; }

                        tsCheck(serverHash, function (stat) {
                            if (stat >= 100) {
                                clearInterval(pollTimer);
                                preloadButton.classList.remove('ts-loading');
                                preloadButton.classList.add('ts-done');
                                preloadButton.textContent = config.always_show ? '✔ 100%' : '✔ В кэше';
                                notify('Предзагрузка завершена');
                            } else {
                                preloadButton.textContent = '⏳ ' + stat + '%';
                            }
                        });
                    }, POLL_INTERVAL);
                });
            });

            item.appendChild(preloadButton);
        });
    }

    // ================= ИНИЦИАЛИЗАЦИЯ =================

    function initializePlugin() {
        try {
            console.log('[TorrServer] Инициализация...');
            registerSettings();
            addMenuItem();
            initTorrentButton();

            if (!document.getElementById('ts-direct-style')) {
                var style = document.createElement('style');
                style.id = 'ts-direct-style';
                style.textContent =
                    '.ts-direct-btn{display:inline-flex;align-items:center;justify-content:center;margin:8px;padding:10px 18px;background:#2d2d2d;color:white;border:2px solid #888;border-radius:6px;font-size:18px;white-space:nowrap;}' +
                    '.ts-direct-btn.focus{border-color:white;background:#51595c;}' +
                    '.ts-direct-preload{background:#2a3a5a;border-color:#5a7ab0;}' +
                    '.ts-direct-preload.focus{background:#3a5a8a;}' +
                    '.ts-direct-preload.ts-done{background:#1f4b3a;border-color:#3fae7a;pointer-events:none;opacity:0.9;}' +
                    '.ts-loading{opacity:0.7;}';
                document.head.appendChild(style);
            }
            console.log('[TorrServer] Плагин загружен');
        } catch (e) { console.error('[TorrServer] init:', e); }
    }

    if (window.Lampa && Lampa.Listener) {
        initializePlugin();
    } else {
        document.addEventListener('appready', initializePlugin);
    }
})();
