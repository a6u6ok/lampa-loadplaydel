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
    var DEF_SMB_FILE = 'smb://192.168.1.50/Media/';
    var DEF_ALWAYS_SHOW = false;

    var DEBUG = true;
    var ACTION_LOCK_MS = 800;

    var CT_FORM = {
        'Content-Type': 'application/x-www-form-urlencoded'
    };

    // Список плееров (включая плееры для Windows и Android)
    var PLAYERS_LIST = {
        '': 'Не выбран',
        'potplayer': 'PotPlayer (Windows)',
        'vlc': 'VLC (Windows / Системный)',
        'org.videolan.vlc': 'VLC (Android)',
        'top.rootu.dddplayer': 'DDD Video Player',
        'com.mxtech.videoplayer.ad': 'MX Player',
        'net.gtvbox.videoplayer': 'Vimu Player',
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
        } catch (error) {}
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
            always_show: isTrue(storeGet('qbit_always_show', DEF_ALWAYS_SHOW), DEF_ALWAYS_SHOW)
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

    function magnetHash(magnet) {
        var match = /urn:btih:([a-zA-Z0-9]+)/i.exec(magnet || '');
        return match ? match[1].toLowerCase() : '';
    }

    // ================= HTTP ЗАПРОСЫ =================

    function nativeRequest(request, callback) {
        var signature = 0;

        function drain() {
            try { AndroidJS.getResp(); } catch (error) {}
        }

        function attempt() {
            if (!window.AndroidJS || typeof AndroidJS.httpReq !== 'function') {
                callback(null);
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
                    callback(null);
                    return;
                }
            } else {
                callback(null);
                return;
            }

            var tries = 0;
            (function poll() {
                tries++;
                var response = null;
                try { response = AndroidJS.getResp(); } catch (error) {}

                if (typeof response === 'string' && response.length) {
                    callback(response);
                    return;
                }
                if (tries > 20) {
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

    function blindRequest(url, method, body) {
        if (typeof fetch !== 'function') {
            notify('Нет поддержки транспорта: нативный запрос недоступен');
            return;
        }

        fetch(url, {
            method: method,
            mode: 'no-cors',
            headers: CT_FORM,
            body: body
        }).then(function () {
            debugNotify('Запрос отправлен (no-cors режим)');
        }).catch(function (error) {
            console.error('[qBittorrent] blind request error:', error);
            notify('Ошибка отправки запроса в qBittorrent');
        });
    }

    // ================= QBITTORRENT API =================

    function makeApiRequest(url, method, body, callback) {
        var config = cfg();

        function execute() {
            nativeRequest({
                url: base() + url,
                method: method || 'GET',
                body: body || '',
                headers: CT_FORM
            }, function (response) {
                if (response && /Forbidden|403|401/i.test(response) && !config.bypass && config.user) {
                    nativeRequest({
                        url: base() + '/api/v2/auth/login',
                        method: 'POST',
                        body: 'username=' + encodeURIComponent(config.user) + '&password=' + encodeURIComponent(config.pass),
                        headers: CT_FORM
                    }, function () {
                        nativeRequest({
                            url: base() + url,
                            method: method || 'GET',
                            body: body || '',
                            headers: CT_FORM
                        }, callback);
                    });
                } else {
                    callback(response);
                }
            });
        }

        if (!config.bypass && config.user) {
            nativeRequest({
                url: base() + '/api/v2/auth/login',
                method: 'POST',
                body: 'username=' + encodeURIComponent(config.user) + '&password=' + encodeURIComponent(config.pass),
                headers: CT_FORM
            }, function () {
                execute();
            });
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

    function checkTorrentProgress(hash, callback) {
        makeApiRequest('/api/v2/torrents/info?hashes=' + hash, 'GET', '', function (response) {
            try {
                if (!response) {
                    callback(false, 0, 'Пустой ответ от сервера');
                    return;
                }
                var data = JSON.parse(response);
                if (Array.isArray(data) && data.length > 0) {
                    var torrent = data[0];
                    var prog = torrent.progress;
                    var st = torrent.state;
                    
                    var isCompleted = (prog >= 1) || 
                                      (st === 'completed') || 
                                      (st.indexOf('UP') !== -1) || 
                                      (st === 'pausedUP') || 
                                      (st === 'stalledUP') || 
                                      (st === 'checkingUP');

                    callback(isCompleted, prog, st);
                } else {
                    callback(false, 0, 'Торрент не найден в qBittorrent');
                }
            } catch (e) {
                callback(false, 0, 'Ошибка разбора ответа');
            }
        });
    }

    function qbAdd(magnet, title, onAdded) {
        if (!magnet || !/^magnet:\?/i.test(magnet)) {
            notify('Magnet-ссылка не найдена');
            return;
        }

        var config = cfg();
        var body = buildAddBody(magnet, title);
        debugNotify('Отправляю в qBittorrent...');

        makeApiRequest('/api/v2/torrents/add', 'POST', body, function (response) {
            if (response === null || response === undefined) {
                blindRequest(base() + '/api/v2/torrents/add', 'POST', body);
            } else if (/Fails/i.test(response)) {
                notify('qBittorrent: ошибка добавления');
                return;
            }
            notify('Добавлено в qBittorrent');
            if (typeof onAdded === 'function') onAdded();
        });
    }

    function qbDelete(magnet, onSuccess) {
        var hash = magnetHash(magnet);
        if (!hash) {
            notify('Не удалось определить hash торрента');
            return;
        }

        var config = cfg();
        var body = 'hashes=' + encodeURIComponent(hash) + '&deleteFiles=' + (config.delete_files ? 'true' : 'false');
        debugNotify('Удаляю торрент из qBittorrent...');

        makeApiRequest('/api/v2/torrents/delete', 'POST', body, function (response) {
            notify(config.delete_files ? 'Торрент и файлы удалены' : 'Торрент удалён из qBittorrent');
            if (typeof onSuccess === 'function') onSuccess();
        });
    }

    // ================= ОТКРЫТИЕ ФАЙЛА В ПЛЕЕРЕ =================

    function openFileInPlayer(fileUri, playerPkg) {
        var uri = String(fileUri || '').trim();
        var pkg = String(playerPkg || '').trim();

        if (!uri) {
            notify('Укажите SMB-путь к файлу в настройках qBittorrent');
            return;
        }

        debugNotify('Открываю файл в плеере: ' + uri);

        try {
            if (window.Lampa && Lampa.Android && typeof Lampa.Android.openPlayer === 'function') {
                Lampa.Android.openPlayer(uri, { package: pkg, title: '' });
                return;
            }
        } catch (e) {}

        try {
            if (window.AndroidJS && typeof AndroidJS.openPlayer === 'function') {
                AndroidJS.openPlayer(uri, pkg, '', 'video/*');
                return;
            }
        } catch (e) {}

        try {
            if (window.AndroidJS && typeof AndroidJS.startActivity === 'function') {
                AndroidJS.startActivity(JSON.stringify({
                    action: 'android.intent.action.VIEW',
                    data: uri,
                    type: 'video/*',
                    package: pkg
                }));
                return;
            }
        } catch (e) {}

        try {
            if (window.Android && typeof Android.openPlayer === 'function') {
                Android.openPlayer(uri, { package: pkg, title: '' });
                return;
            }
        } catch (e) {}

        notify('Не удалось открыть файл в плеере');
    }

    function handlePlayerButton() {
        var config = cfg();
        if (!config.player_package || config.player_package === 'custom') {
            notify('Плеер не выбран. Зайдите в настройки qBittorrent.');
            return;
        }
        openFileInPlayer(config.smb_file, config.player_package);
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

    // ================= НАСТРОЙКИ И ИНТЕРФЕЙС =================

    function registerSettings() {
        try {
            if (!window.Lampa || !Lampa.SettingsApi) return;

            Lampa.SettingsApi.addComponent({
                component: 'qbit_direct',
                icon: '<svg viewBox="0 0 24 24" width="24" height="24"><path fill="currentColor" d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>',
                name: 'qBittorrent'
            });

            var params = [
                { name: 'qbit_url', type: 'input', def: DEF_URL, title: 'Адрес сервера', desc: 'Адрес Web UI qBittorrent, например http://192.168.1.50:8080' },
                { name: 'qbit_user', type: 'input', def: DEF_USER, title: 'Логин', desc: 'Логин, если не используется обход аутентификации' },
                { name: 'qbit_pass', type: 'input', def: DEF_PASS, title: 'Пароль', desc: 'Пароль, если не используется обход аутентификации' },
                { name: 'qbit_bypass', type: 'trigger', def: DEF_BYPASS, title: 'Обход аутентификации', desc: 'Включи обход аутентификации для локальной сети в qBittorrent' },
                { name: 'qbit_savepath', type: 'input', def: DEF_SAVEPATH, title: 'Базовый путь сохранения', desc: 'Например: /app/qBittorrent. Пусто = по умолчанию' },
                { name: 'qbit_category', type: 'input', def: DEF_CATEGORY, title: 'Категория', desc: 'Категория для торрентов, например video' },
                { name: 'qbit_auto_cat_path', type: 'trigger', def: DEF_AUTO_CAT_PATH, title: 'Добавлять категорию к пути', desc: 'Например: /app/qBittorrent + video' },
                { name: 'qbit_rename', type: 'trigger', def: DEF_RENAME, title: 'Переименовывать торрент', desc: 'Использовать название раздачи как имя торрента' },
                { name: 'qbit_confirm', type: 'trigger', def: DEF_CONFIRM, title: 'Проверять добавление', desc: 'Проверять, появился ли торрент в qBittorrent' },
                { name: 'qbit_delete_files', type: 'trigger', def: DEF_DELETE_FILES, title: 'Удалять файлы торрента', desc: 'При удалении также удалять скачанные файлы' },
                { name: 'qbit_always_show', type: 'trigger', def: DEF_ALWAYS_SHOW, title: 'Всегда показывать кнопки управления', desc: 'Показывать плеер и удаление сразу, не дожидаясь 100% скачивания' },
                { name: 'qbit_smb_file', type: 'input', def: DEF_SMB_FILE, title: 'SMB-путь к файлу или папке', desc: 'Например: smb://192.168.1.50/Media/Movie.mkv' }
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
                param: { name: 'qbit_player_package', type: 'select', values: PLAYERS_LIST, default: '' },
                field: { name: 'Видеоплеер', description: 'Выберите плеер из списка для кнопки «Открыть плеер»' }
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
                Lampa.Controller.toggle('settings');
                setTimeout(function () {
                    var item = document.querySelector('[data-component="qbit_direct"]');
                    if (item) item.click();
                }, 100);
            });
        } catch (error) {
            console.error('[qBittorrent] Ошибка добавления пункта меню:', error);
        }
    }

    function createButton(className, text, handler) {
        var button = document.createElement('div');
        button.className = 'qbit-direct-btn ' + className + ' selector';
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

            var magnet = data.MagnetUri || data.magnetUri || '';
            var title = data.Title || data.title || '';
            var hash = magnetHash(magnet);

            if (!item || !hash) return;
            if (item.querySelector('.qbit-direct-actions[data-hash="' + hash + '"]')) return;

            var config = cfg();
            var actions = document.createElement('div');
            actions.className = 'qbit-direct-actions';
            actions.setAttribute('data-hash', hash);

            var addButton = createButton('qbit-direct-add', '⬇ В qBittorrent', function () {
                qbAdd(magnet, title, function () {
                    if (!config.always_show) startPolling();
                });
            });

            var playerButton = createButton('qbit-direct-player', '▶ Открыть плеер', function () {
                handlePlayerButton();
            });
            var deleteButton = createButton('qbit-direct-delete', '🗑 Удалить', function () {
                qbDelete(magnet, function () {
                    if (!config.always_show) {
                        playerButton.style.display = 'none';
                        deleteButton.style.display = 'none';
                    }
                });
            });

            if (!config.always_show) {
                playerButton.style.display = 'none';
                deleteButton.style.display = 'none';
            }

            actions.appendChild(addButton);
            actions.appendChild(playerButton);
            actions.appendChild(deleteButton);

            item.appendChild(actions);

            var pollTimer = null;
            function startPolling() {
                if (pollTimer) clearInterval(pollTimer);
                checkStatus();
                pollTimer = setInterval(checkStatus, 5000);
            }

            function checkStatus() {
                checkTorrentProgress(hash, function (isCompleted, progress, state) {
                    if (isCompleted) {
                        playerButton.style.display = 'inline-flex';
                        deleteButton.style.display = 'inline-flex';
                        addButton.textContent = '⬇ В qBittorrent (Скачано)';
                        if (pollTimer) clearInterval(pollTimer);
                    } else {
                        if (progress > 0 && progress < 1) {
                            addButton.textContent = '⬇ Скачивание: ' + Math.round(progress * 100) + '% (' + state + ')';
                        }
                    }
                });
            }

            if (!config.always_show) {
                startPolling();
            }
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
            console.log('[qBittorrent] Плагин загружен');
        } catch (error) {
            console.error('[qBittorrent] Ошибка инициализации:', error);
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
