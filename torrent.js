// ============================================================================
// Плагин qBittorrent для Lampa.
// Сделан на основе плагина: https://github.com/kostya4000/lampa-qbit
// Автор оригинала: kostya4000
// ============================================================================

(function () {
    'use strict';

    // ================= ЗНАЧЕНИЯ ПО УМОЛЧАНИЮ =================

    var DEF_URL = 'http://192.168.1.50:8080';
    var DEF_USER = '';
    var DEF_PASS = '';
    var DEF_BYPASS = true;
    var DEF_SAVEPATH = '';
    var DEF_CATEGORY = '';
    var DEF_RENAME = true;
    var DEF_CONFIRM = true;
    var DEF_AUTO_CAT_PATH = true;
    var DEF_DELETE_FILES = false;
    var DEF_PLAYER_PACKAGE = '';
    var DEF_SMB_FILE = 'smb://192.168.1.50/download/';
    var DEF_ALWAYS_SHOW = true;
    var DEF_VERBOSE = false;

    var DEBUG = true;
    var ACTION_LOCK_MS = 800;
    var DELETE_LOCK_MS = 1800;
    var NATIVE_TIMEOUT_TRIES = 30; // 30 * 150ms = 4.5s

    var CT_FORM = {
        'Content-Type': 'application/x-www-form-urlencoded'
    };

    var PLAYERS_LIST = {
        '': 'Не выбран',
        'net.gtvbox.videoplayer': 'Vimu Player',
        'org.videolan.vlc': 'VLC (Android)',
        'top.rootu.dddplayer': 'DDD Video Player',
        'com.mxtech.videoplayer.ad': 'MX Player',
        'com.brouken.player': 'Just (Video) Player',
        'org.xbmc.kodi': 'Kodi',
        'com.newin.nplayer.pro': 'nPlayer',
        'com.xplayer.player': 'Xplayer',
        'org.courville.nova': 'Nova Video Player',
        'com.archos.mediacenter.video': 'Archos Video Player',
        'custom': 'Другой (ввести вручную)'
    };

    // ================= УТИЛИТЫ =================

    function notify(text) {
        try {
            if (window.Lampa && Lampa.Noty) {
                Lampa.Noty.show(text);
                return;
            }
        } catch (error) {
            console.warn('[qBittorrent] notify error:', error);
        }
        console.log('[qBittorrent]', text);
    }

    function debugNotify(text) {
        if (DEBUG) notify(text);
    }

    function storeGet(key, defaultValue) {
        try {
            if (window.Lampa && Lampa.Storage) {
                var value = Lampa.Storage.get(key, defaultValue);
                if (value !== undefined && value !== null) {
                    return value;
                }
            }
        } catch (error) {
            if (DEBUG) console.warn('[qBittorrent] storeGet error:', key, error);
        }
        return defaultValue;
    }

    function storeSet(key, value) {
        try {
            if (window.Lampa && Lampa.Storage) {
                Lampa.Storage.set(key, value);
            }
        } catch (error) {
            console.error('[qBittorrent] storeSet error:', error);
        }
    }

    function isTrue(value, defaultValue) {
        if (value === true || value === 'true') return true;
        if (value === false || value === 'false') return false;
        return defaultValue;
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
            auto_cat_path: isTrue(
                storeGet('qbit_auto_cat_path', DEF_AUTO_CAT_PATH),
                DEF_AUTO_CAT_PATH
            ),
            delete_files: isTrue(
                storeGet('qbit_delete_files', DEF_DELETE_FILES),
                DEF_DELETE_FILES
            ),
            player_package: storeGet('qbit_player_package', DEF_PLAYER_PACKAGE),
            smb_file: storeGet('qbit_smb_file', DEF_SMB_FILE),
            always_show: isTrue(storeGet('qbit_always_show', DEF_ALWAYS_SHOW), DEF_ALWAYS_SHOW),
            verbose: isTrue(storeGet('qbit_verbose', DEF_VERBOSE), DEF_VERBOSE)
        };
    }

    function base() {
        return String(cfg().url || '').replace(/\/+$/, '');
    }

    function joinPath(basePath, subPath) {
        if (!basePath) return subPath || '';
        if (!subPath) return basePath;
        return String(basePath).replace(/\/+$/, '') + '/' + String(subPath).replace(/^\/+/, '');
    }

    // Поддержка hex (40) и base32 (32) хэшей magnet-ссылок.
    // qBittorrent API принимает оба варианта, но base32 - только в верхнем регистре.
    function magnetHash(magnet) {
        var match = /urn:btih:([a-zA-Z0-9]+)/i.exec(magnet || '');
        if (!match) return '';
        var h = match[1];
        if (h.length === 40) return h.toLowerCase();   // hex
        if (h.length === 32) return h.toUpperCase();   // base32
        return '';
    }

    // Кодирование пути посегментно, чтобы не превращать '/' в '%2F'
    function encodePathSegments(path) {
        return String(path || '')
            .split('/')
            .map(function (seg) { return encodeURIComponent(seg); })
            .join('/');
    }

    // ================= HTTP ЗАПРОСЫ =================

    function nativeRequest(request, callback) {
        var signature = 0;
        var finished = false;

        function safeCallback(resp) {
            if (finished) return;
            finished = true;
            callback(resp);
        }

        function drain() {
            try { AndroidJS.getResp(); } catch (error) {}
        }

        function attempt() {
            if (!window.AndroidJS || typeof AndroidJS.httpReq !== 'function') {
                safeCallback(null);
                return;
            }

            if (signature === 0) {
                try {
                    AndroidJS.httpReq(JSON.stringify(request));
                } catch (error) {
                    signature++;
                    attempt();
                    return;
                }
            } else if (signature === 1) {
                try {
                    AndroidJS.httpReq(
                        request.url,
                        JSON.stringify({
                            method: request.method,
                            body: request.body || '',
                            headers: request.headers || {}
                        })
                    );
                } catch (error) {
                    safeCallback(null);
                    return;
                }
            } else {
                safeCallback(null);
                return;
            }

            var tries = 0;
            (function poll() {
                tries++;
                var response = null;
                try { response = AndroidJS.getResp(); } catch (error) {}

                if (typeof response === 'string' && response.length) {
                    safeCallback(response);
                    return;
                }
                if (tries > NATIVE_TIMEOUT_TRIES) {
                    signature++;
                    attempt();
                    return;
                }
                setTimeout(poll, 150);
            })();
        }

        drain();
        attempt();
    }

    // ================= QBITTORRENT API =================

    function login(callback) {
        var config = cfg();
        if (!config.user) {
            // Нет логина - не пытаемся, просто продолжаем
            callback();
            return;
        }
        nativeRequest({
            url: base() + '/api/v2/auth/login',
            method: 'POST',
            body: 'username=' + encodeURIComponent(config.user) +
                  '&password=' + encodeURIComponent(config.pass),
            headers: CT_FORM
        }, function () {
            callback();
        });
    }

    // Универсальный запрос с (опциональной) авторизацией и повтором при 403
    function apiRequest(url, method, body, callback) {
        var config = cfg();

        function doRequest(cb) {
            nativeRequest({
                url: base() + url,
                method: method || 'GET',
                body: body || '',
                headers: CT_FORM
            }, cb);
        }

        function execute() {
            doRequest(function (response) {
                if (response && /Forbidden|403|401/i.test(response) && !config.bypass && config.user) {
                    login(function () {
                        doRequest(callback);
                    });
                } else {
                    callback(response);
                }
            });
        }

        if (!config.bypass && config.user) {
            login(function () { execute(); });
        } else {
            execute();
        }
    }

    function buildAddBody(magnet, title) {
        var config = cfg();
        var body = 'urls=' + encodeURIComponent(magnet);
        var finalSavePath = config.savepath || '';
        var autoTMM = false;

        if (config.auto_cat_path && config.category) {
            if (finalSavePath) {
                finalSavePath = joinPath(finalSavePath, config.category);
            } else {
                autoTMM = true;
            }
        }

        if (finalSavePath) body += '&savepath=' + encodeURIComponent(finalSavePath);
        if (config.category) body += '&category=' + encodeURIComponent(config.category);
        if (config.rename && title) body += '&rename=' + encodeURIComponent(title);

        body += '&paused=false&stopped=false';
        body += '&autoTMM=' + (autoTMM ? 'true' : 'false');

        return body;
    }

    function qbAdd(magnet, title, onAdded) {
        if (!magnet || !/^magnet:\?/i.test(magnet)) {
            notify('Magnet-ссылка не найдена');
            return;
        }

        var body = buildAddBody(magnet, title);
        debugNotify('Отправляю в qBittorrent...');

        apiRequest('/api/v2/torrents/add', 'POST', body, function (response) {
            if (response === null || response === undefined) {
                // Нативный транспорт недоступен - сообщаем честно
                notify('Не удалось отправить запрос: нативный транспорт недоступен');
                return;
            }
            if (/Fails/i.test(response)) {
                notify('qBittorrent: ошибка добавления');
                return;
            }
            notify('Добавлено в qBittorrent ✓');
            if (typeof onAdded === 'function') onAdded();
        });
    }

    function qbDelete(magnet) {
        var hash = magnetHash(magnet);
        if (!hash) {
            notify('Не удалось определить hash торрента');
            return;
        }

        var config = cfg();
        if (config.confirm) {
            var ok = window.confirm
                ? window.confirm('Удалить торрент' + (config.delete_files ? ' и файлы с диска' : '') + '?')
                : true;
            if (!ok) return;
        }

        var body = 'hashes=' + encodeURIComponent(hash) +
                   '&deleteFiles=' + (config.delete_files ? 'true' : 'false');
        debugNotify('Удаляю торрент из qBittorrent...');

        apiRequest('/api/v2/torrents/delete', 'POST', body, function (response) {
            console.log('[qBittorrent] delete response:', response);
            if (response === null || response === undefined) {
                notify('Не удалось отправить запрос: нативный транспорт недоступен');
                return;
            }
            if (/Forbidden|403/i.test(response)) {
                notify('qBittorrent: 403. Проверь доступ к Web UI');
                return;
            }
            notify(config.delete_files ? 'Торрент и файлы удалены с роутера' : 'Торрент удалён из qBittorrent');
        });
    }

    // ================= ОТКРЫТИЕ ФАЙЛА В ПЛЕЕРЕ =================

    function openFileInPlayer(fileUri, playerPkg, fileName) {
        var baseUri = String(fileUri || '').trim().replace(/\/+$/, '');
        var pkg = String(playerPkg || '').trim();
        var targetFile = String(fileName || '').trim();

        if (!baseUri) {
            notify('Укажите SMB-путь к файлу в настройках qBittorrent');
            return;
        }

        var finalUri = baseUri;
        if (targetFile) {
            finalUri = baseUri + '/' + encodePathSegments(targetFile);
        }

        debugNotify('Открываю в плеере: ' + finalUri);

        try {
            if (window.Lampa && Lampa.Android && typeof Lampa.Android.openPlayer === 'function') {
                Lampa.Android.openPlayer(finalUri, { package: pkg, title: targetFile });
                return;
            }
        } catch (e) {}

        try {
            if (window.AndroidJS && typeof AndroidJS.openPlayer === 'function') {
                AndroidJS.openPlayer(finalUri, pkg, targetFile, 'video/*');
                return;
            }
        } catch (e) {}

        try {
            if (window.AndroidJS && typeof AndroidJS.startActivity === 'function') {
                AndroidJS.startActivity(JSON.stringify({
                    action: 'android.intent.action.VIEW',
                    data: finalUri,
                    type: 'video/*',
                    package: pkg
                }));
                return;
            }
        } catch (e) {}

        try {
            if (window.Android && typeof Android.openPlayer === 'function') {
                Android.openPlayer(finalUri, { package: pkg, title: targetFile });
                return;
            }
        } catch (e) {}

        notify('Не удалось открыть файл в плеере');
    }

    function handlePlayerButton(fileName) {
        var config = cfg();
        if (!config.player_package || config.player_package === 'custom') {
            notify('Плеер не выбран в настройках.');
            return;
        }
        openFileInPlayer(config.smb_file, config.player_package, fileName);
    }

    // ================= НАЖАТИЯ =================

    function bindPress(element, handler, lockMs) {
        var last = 0;
        var lock = typeof lockMs === 'number' ? lockMs : ACTION_LOCK_MS;
        function wrapped(event) {
            var now = Date.now();
            if (now - last < lock) return;
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

    // ================= НАСТРОЙКИ И ИНТЕРФЕЙС =================

    function registerSettings() {
        try {
            if (!window.Lampa || !Lampa.SettingsApi) return;

            Lampa.SettingsApi.addComponent({
                component: 'qbit_direct',
                icon: '<svg viewBox="0 0 24 24" width="24" height="24"><path fill="currentColor" d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>',
                name: 'qBittorrent (Роутер)'
            });

            var params = [
                { name: 'qbit_url', type: 'input', def: DEF_URL, title: 'Адрес роутера', desc: 'Например http://192.168.1.50:8080' },
                { name: 'qbit_user', type: 'input', def: DEF_USER, title: 'Логин', desc: 'Логин qBittorrent в Entware' },
                { name: 'qbit_pass', type: 'input', def: DEF_PASS, title: 'Пароль', desc: 'Пароль qBittorrent в Entware' },
                { name: 'qbit_bypass', type: 'trigger', def: DEF_BYPASS, title: 'Обход аутентификации', desc: 'Для локальной сети' },
                { name: 'qbit_savepath', type: 'input', def: DEF_SAVEPATH, title: 'Путь сохранения на диске', desc: 'Например /opt/var/torrents' },
                { name: 'qbit_category', type: 'input', def: DEF_CATEGORY, title: 'Категория', desc: 'Категория торрентов' },
                { name: 'qbit_auto_cat_path', type: 'trigger', def: DEF_AUTO_CAT_PATH, title: 'Добавлять категорию к пути', desc: 'Авто-поддиректория' },
                { name: 'qbit_rename', type: 'trigger', def: DEF_RENAME, title: 'Переименовывать торрент', desc: 'Имя раздачи' },
                { name: 'qbit_confirm', type: 'trigger', def: DEF_CONFIRM, title: 'Подтверждать удаление', desc: 'Спрашивать перед удалением торрента' },
                { name: 'qbit_delete_files', type: 'trigger', def: DEF_DELETE_FILES, title: 'Удалять файлы с диска', desc: 'При удалении торрента' },
                { name: 'qbit_always_show', type: 'trigger', def: DEF_ALWAYS_SHOW, title: 'Всегда показывать кнопки управления', desc: 'Не ждать опроса 100% статуса (рекомендуется для роутера)' },
                { name: 'qbit_smb_file', type: 'input', def: DEF_SMB_FILE, title: 'SMB-путь к папке/файлу', desc: 'Например smb://192.168.1.50/download/' },
                { name: 'qbit_verbose', type: 'trigger', def: DEF_VERBOSE, title: 'Подробные уведомления', desc: 'Показывать отладочные сообщения' }
            ];

            params.forEach(function (p) {
                Lampa.SettingsApi.addParam({
                    component: 'qbit_direct',
                    param: { name: p.name, type: p.type, values: '', default: p.def },
                    field: { name: p.title, description: p.desc }
                });
            });

            Lampa.SettingsApi.addParam({
                component: 'qbit_direct',
                param: { name: 'qbit_player_package', type: 'select', values: PLAYERS_LIST, default: 'net.gtvbox.videoplayer' },
                field: { name: 'Видеоплеер (Android TV)', description: 'Выберите плеер (например Vimu)' }
            });
        } catch (error) {
            console.error('[qBittorrent] Ошибка регистрации настроек:', error);
        }
    }

    function addMenuItem() {
        try {
            if (!window.Lampa || !Lampa.Menu || typeof Lampa.Menu.addButton !== 'function') return;

            var icon = '<svg viewBox="0 0 24 24" width="24" height="24">' +
                '<path fill="currentColor" d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>';

            Lampa.Menu.addButton(icon, 'qBittorrent', function () {
                try { Lampa.Controller.toggle('settings'); } catch (e) {}
                setTimeout(function () {
                    var item = document.querySelector('[data-component="qbit_direct"]');
                    if (!item) return;
                    try { item.dispatchEvent(new Event('hover:enter')); } catch (e) {}
                    try { item.click(); } catch (e) {}
                }, 120);
            });
        } catch (error) {
            console.error('[qBittorrent] Ошибка добавления пункта меню:', error);
        }
    }

    function createButton(className, text, handler, lockMs) {
        var button = document.createElement('div');
        button.className = 'qbit-direct-btn ' + className + ' selector';
        button.tabIndex = 0;
        button.textContent = text;
        bindPress(button, handler, lockMs);
        return button;
    }

    function initTorrentButton() {
        if (!window.Lampa || !Lampa.Listener) return;

        Lampa.Listener.follow('torrent', function (event) {
            if (!event || event.type !== 'render' || !event.item) return;

            var item = event.item.jquery ? event.item[0] : event.item;
            if (!item || typeof item.querySelector !== 'function') return;

            var data = event.element || event.data || {};
            var magnet = data.MagnetUri || data.magnetUri || '';

            var fileName = data.file || data.filename || data.name || data.Title || data.title || '';
            var hash = magnetHash(magnet);

            if (!hash) return;
            if (item.querySelector('.qbit-direct-actions[data-hash="' + hash + '"]')) return;

            var actions = document.createElement('div');
            actions.className = 'qbit-direct-actions';
            actions.setAttribute('data-hash', hash);

            var addButton = createButton('qbit-direct-add', '⬇ В qBittorrent', function () {
                qbAdd(magnet, fileName);
            }, ACTION_LOCK_MS);

            var playerButton = createButton('qbit-direct-player', '▶ Открыть плеер', function () {
                handlePlayerButton(fileName);
            }, ACTION_LOCK_MS);

            var deleteButton = createButton('qbit-direct-delete', '🗑 Удалить', function () {
                qbDelete(magnet);
            }, DELETE_LOCK_MS);

            actions.appendChild(addButton);
            actions.appendChild(playerButton);
            actions.appendChild(deleteButton);

            item.appendChild(actions);
        });
    }

    // ================= ИНИЦИАЛИЗАЦИЯ =================

    function initializePlugin() {
        try {
            registerSettings();
            addMenuItem();
            initTorrentButton();

            if (!document.getElementById('qbit-direct-style')) {
                var style = document.createElement('style');
                style.id = 'qbit-direct-style';
                style.textContent =
                    '.qbit-direct-actions{display:inline-flex;align-items:center;position:relative;z-index:999;flex-wrap:wrap;}' +
                    '.qbit-direct-btn{display:inline-flex;align-items:center;justify-content:center;margin:8px;padding:10px 18px;background:#303638;color:white;border:2px solid #888;border-radius:6px;font-size:18px;white-space:nowrap;}' +
                    '.qbit-direct-btn.focus{border-color:white;background:#51595c;}' +
                    '.qbit-direct-player{background:#1f4b3a;border-color:#3fae7a;}' +
                    '.qbit-direct-player.focus{background:#2c6b51;}' +
                    '.qbit-direct-delete{background:#4b2323;border-color:#ae3f3f;}' +
                    '.qbit-direct-delete.focus{background:#6b2c2c;}' +
                    '@media screen and (max-width: 768px) { .qbit-direct-btn { font-size: 14px; padding: 8px 12px; margin: 4px; } }';
                document.head.appendChild(style);
            }
            console.log('[qBittorrent Router] Плагин загружен');
        } catch (error) {
            console.error('[qBittorrent Router] Ошибка инициализации:', error);
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
