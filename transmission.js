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

    var DEBUG = true;
    var ACTION_LOCK_MS = 800;

    var CT_FORM = {
        'Content-Type': 'application/x-www-form-urlencoded'
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
            player_package: storeGet('qbit_player_package', DEF_PLAYER_PACKAGE)
        };
    }

    function base() {
        return String(cfg().url || '').replace(/\/+$/, '');
    }

    function joinPath(basePath, subPath) {
        if (!basePath) return subPath || '';
        if (!subPath) return basePath;

        return (
            String(basePath).replace(/\/+$/, '') +
            '/' +
            String(subPath).replace(/^\/+/, '')
        );
    }

    function magnetHash(magnet) {
        var match = /urn:btih:([a-zA-Z0-9]+)/.exec(magnet || '');

        return match ? match[1].toLowerCase() : '';
    }

    // ================= HTTP ЗАПРОСЫ =================

    function nativeRequest(request, callback) {
        var signature = 0;

        function drain() {
            try {
                AndroidJS.getResp();
            } catch (error) {}
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

                try {
                    response = AndroidJS.getResp();
                } catch (error) {}

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
        })
            .then(function () {
                notify('Запрос отправлен, но ответ недоступен для проверки');
            })
            .catch(function (error) {
                console.error('[qBittorrent] blind request error:', error);
                notify('Ошибка отправки запроса в qBittorrent');
            });
    }

    // ================= QBITTORRENT =================

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

        if (finalSavePath) {
            body += '&savepath=' + encodeURIComponent(finalSavePath);
        }

        if (config.category) {
            body += '&category=' + encodeURIComponent(config.category);
        }

        if (config.rename && title) {
            body += '&rename=' + encodeURIComponent(title);
        }

        body += '&paused=false&stopped=false';
        body += '&autoTMM=' + (autoTMM ? 'true' : 'false');

        console.log('[qBittorrent] add body:', body);

        return body;
    }

    function confirmAdded(magnet, callback) {
        var hash = magnetHash(magnet);

        if (!hash) {
            callback(false);
            return;
        }

        nativeRequest(
            {
                url: base() + '/api/v2/torrents/info?hashes=' + hash,
                method: 'GET'
            },
            function (response) {
                callback(
                    typeof response === 'string' &&
                        response.toLowerCase().indexOf(hash) !== -1
                );
            }
        );
    }

    function qbAdd(magnet, title) {
        if (!magnet || !/^magnet:\?/i.test(magnet)) {
            notify('Magnet-ссылка не найдена');
            return;
        }

        var config = cfg();
        var body = buildAddBody(magnet, title);

        debugNotify('Отправляю в qBittorrent...');

        function finishAdd(response) {
            if (response === null || response === undefined) {
                blindRequest(
                    base() + '/api/v2/torrents/add',
                    'POST',
                    body
                );

                return;
            }

            console.log('[qBittorrent] add response:', response);

            if (/Forbidden|403/i.test(response)) {
                notify('qBittorrent: 403. Проверь доступ к Web UI');
                return;
            }

            if (/Fails/i.test(response)) {
                notify('qBittorrent: ошибка добавления');
                return;
            }

            if (config.confirm) {
                confirmAdded(magnet, function (added) {
                    notify(
                        added
                            ? 'Добавлено в qBittorrent ✓'
                            : 'Отправлено в qBittorrent, подтверждение не получено'
                    );
                });
            } else {
                notify('Отправлено в qBittorrent');
            }
        }

        function addRequest() {
            nativeRequest(
                {
                    url: base() + '/api/v2/torrents/add',
                    method: 'POST',
                    body: body,
                    headers: CT_FORM
                },
                finishAdd
            );
        }

        if (!config.bypass && config.user) {
            nativeRequest(
                {
                    url: base() + '/api/v2/auth/login',
                    method: 'POST',
                    body:
                        'username=' + encodeURIComponent(config.user) +
                        '&password=' + encodeURIComponent(config.pass),
                    headers: CT_FORM
                },
                addRequest
            );
        } else {
            addRequest();
        }
    }

    function qbDelete(magnet) {
        var hash = magnetHash(magnet);

        if (!hash) {
            notify('Не удалось определить hash торрента');
            return;
        }

        var config = cfg();
        var body =
            'hashes=' + encodeURIComponent(hash) +
            '&deleteFiles=' + (config.delete_files ? 'true' : 'false');

        debugNotify('Удаляю торрент из qBittorrent...');

        function finishDelete(response) {
            console.log('[qBittorrent] delete response:', response);

            if (response === null || response === undefined) {
                blindRequest(
                    base() + '/api/v2/torrents/delete',
                    'POST',
                    body
                );

                return;
            }

            if (/Forbidden|403/i.test(response)) {
                notify('qBittorrent: 403. Проверь доступ к Web UI');
                return;
            }

            notify(
                config.delete_files
                    ? 'Торрент и файлы удалены из qBittorrent'
                    : 'Торрент удалён из qBittorrent'
            );
        }

        function deleteRequest() {
            nativeRequest(
                {
                    url: base() + '/api/v2/torrents/delete',
                    method: 'POST',
                    body: body,
                    headers: CT_FORM
                },
                finishDelete
            );
        }

        if (!config.bypass && config.user) {
            nativeRequest(
                {
                    url: base() + '/api/v2/auth/login',
                    method: 'POST',
                    body:
                        'username=' + encodeURIComponent(config.user) +
                        '&password=' + encodeURIComponent(config.pass),
                    headers: CT_FORM
                },
                deleteRequest
            );
        } else {
            deleteRequest();
        }
    }

    // ================= ВЫБОР И ЗАПУСК ПЛЕЕРА =================

    var TEST_VIDEO_URL =
        'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerBlazes.mp4';

    function launchByPackage(packageName) {
        var pkg = String(packageName || '').trim();

        if (!pkg) return false;

        debugNotify('Запускаю плеер: ' + pkg);

        try {
            if (
                window.Lampa &&
                Lampa.Android &&
                typeof Lampa.Android.openPlayer === 'function'
            ) {
                Lampa.Android.openPlayer('', {
                    package: pkg,
                    title: ''
                });
                return true;
            }

            if (
                window.AndroidJS &&
                typeof AndroidJS.openPlayer === 'function'
            ) {
                AndroidJS.openPlayer('', pkg, '', 'video/*');
                return true;
            }

            if (
                window.Android &&
                typeof Android.openPlayer === 'function'
            ) {
                Android.openPlayer('', {
                    package: pkg,
                    title: ''
                });
                return true;
            }
        } catch (error) {
            console.error('[qBittorrent] player launch error:', error);
        }

        return false;
    }

    function showSystemPlayerPicker() {
        var viewIntent = {
            action: 'android.intent.action.VIEW',
            data: TEST_VIDEO_URL,
            type: 'video/*'
        };

        var pickIntent = {
            action: 'android.intent.action.PICK_ACTIVITY',
            extra: {
                'android.intent.extra.INTENT': viewIntent
            }
        };

        // 1) PICK_ACTIVITY через startActivityForResult — без запуска приложения
        try {
            if (
                window.AndroidJS &&
                typeof AndroidJS.startActivityForResult === 'function'
            ) {
                AndroidJS.startActivityForResult(JSON.stringify(pickIntent));
                notify('Выберите плеер из списка');
                return;
            }
        } catch (e) {
            console.warn('[qBittorrent] startActivityForResult failed:', e);
        }

        // 2) PICK_ACTIVITY через startActivity
        try {
            if (
                window.AndroidJS &&
                typeof AndroidJS.startActivity === 'function'
            ) {
                AndroidJS.startActivity(JSON.stringify(pickIntent));
                notify('Выберите плеер из списка');
                return;
            }
        } catch (e) {
            console.warn('[qBittorrent] startActivity(PICK) failed:', e);
        }

        // 3) ACTION_VIEW через нативные мосты Lampa (без location.href)
        try {
            if (
                window.Lampa &&
                Lampa.Android &&
                typeof Lampa.Android.openPlayer === 'function'
            ) {
                Lampa.Android.openPlayer(TEST_VIDEO_URL, {
                    title: 'Выбор плеера'
                });
                notify('Выберите плеер из списка');
                return;
            }

            if (
                window.AndroidJS &&
                typeof AndroidJS.openPlayer === 'function'
            ) {
                AndroidJS.openPlayer(TEST_VIDEO_URL, '', 'Выбор плеера', 'video/*');
                notify('Выберите плеер из списка');
                return;
            }

            if (
                window.Android &&
                typeof Android.openPlayer === 'function'
            ) {
                Android.openPlayer(TEST_VIDEO_URL, {
                    title: 'Выбор плеера'
                });
                notify('Выберите плеер из списка');
                return;
            }
        } catch (e) {
            console.warn('[qBittorrent] openPlayer(VIEW) failed:', e);
        }

        notify('Не удалось открыть выбор плеера');
    }

    function handlePlayerButton() {
        var config = cfg();

        if (config.player_package) {
            if (launchByPackage(config.player_package)) {
                notify('Запускаю плеер');
                return;
            }

            notify('Плеер не найден, выберите заново');
            storeSet('qbit_player_package', '');
        }

        showSystemPlayerPicker();
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

                if (event.stopImmediatePropagation) {
                    event.stopImmediatePropagation();
                }
            }

            handler(event);
        }

        element.addEventListener('hover:enter', wrapped);
        element.addEventListener('click', wrapped);
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
                icon:
                    '<svg viewBox="0 0 24 24" width="24" height="24"><path fill="currentColor" d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>',
                name: 'qBittorrent'
            });

            Lampa.SettingsApi.addParam({
                component: 'qbit_direct',
                param: {
                    name: 'qbit_url',
                    type: 'input',
                    values: '',
                    default: DEF_URL
                },
                field: {
                    name: 'Адрес сервера',
                    description:
                        'Адрес Web UI qBittorrent, например http://192.168.1.50:8080'
                }
            });

            Lampa.SettingsApi.addParam({
                component: 'qbit_direct',
                param: {
                    name: 'qbit_user',
                    type: 'input',
                    values: '',
                    default: DEF_USER
                },
                field: {
                    name: 'Логин',
                    description:
                        'Логин, если не используется обход аутентификации'
                }
            });

            Lampa.SettingsApi.addParam({
                component: 'qbit_direct',
                param: {
                    name: 'qbit_pass',
                    type: 'input',
                    values: '',
                    default: DEF_PASS
                },
                field: {
                    name: 'Пароль',
                    description:
                        'Пароль, если не используется обход аутентификации'
                }
            });

            Lampa.SettingsApi.addParam({
                component: 'qbit_direct',
                param: {
                    name: 'qbit_bypass',
                    type: 'trigger',
                    default: DEF_BYPASS
                },
                field: {
                    name: 'Обход аутентификации',
                    description:
                        'Включи обход аутентификации для локальной сети в qBittorrent'
                }
            });

            Lampa.SettingsApi.addParam({
                component: 'qbit_direct',
                param: {
                    name: 'qbit_savepath',
                    type: 'input',
                    values: '',
                    default: DEF_SAVEPATH
                },
                field: {
                    name: 'Базовый путь сохранения',
                    description:
                        'Например: /app/qBittorrent. Пусто = путь qBittorrent по умолчанию'
                }
            });

            Lampa.SettingsApi.addParam({
                component: 'qbit_direct',
                param: {
                    name: 'qbit_category',
                    type: 'input',
                    values: '',
                    default: DEF_CATEGORY
                },
                field: {
                    name: 'Категория',
                    description: 'Категория для торрентов, например video'
                }
            });

            Lampa.SettingsApi.addParam({
                component: 'qbit_direct',
                param: {
                    name: 'qbit_auto_cat_path',
                    type: 'trigger',
                    default: DEF_AUTO_CAT_PATH
                },
                field: {
                    name: 'Добавлять категорию к пути',
                    description:
                        'Например: /app/qBittorrent + video = /app/qBittorrent/video'
                }
            });

            Lampa.SettingsApi.addParam({
                component: 'qbit_direct',
                param: {
                    name: 'qbit_rename',
                    type: 'trigger',
                    default: DEF_RENAME
                },
                field: {
                    name: 'Переименовывать торрент',
                    description:
                        'Использовать название раздачи как имя торрента'
                }
            });

            Lampa.SettingsApi.addParam({
                component: 'qbit_direct',
                param: {
                    name: 'qbit_confirm',
                    type: 'trigger',
                    default: DEF_CONFIRM
                },
                field: {
                    name: 'Проверять добавление',
                    description:
                        'Проверять, появился ли торрент в qBittorrent'
                }
            });

            Lampa.SettingsApi.addParam({
                component: 'qbit_direct',
                param: {
                    name: 'qbit_delete_files',
                    type: 'trigger',
                    default: DEF_DELETE_FILES
                },
                field: {
                    name: 'Удалять файлы торрента',
                    description:
                        'При удалении также удалять скачанные файлы на сервере'
                }
            });

            Lampa.SettingsApi.addParam({
                component: 'qbit_direct',
                param: {
                    name: 'qbit_player_package',
                    type: 'input',
                    values: '',
                    default: DEF_PLAYER_PACKAGE
                },
                field: {
                    name: 'Пакет плеера',
                    description:
                        'Заполняется автоматически после выбора плеера. Например org.videolan.vlc'
                }
            });

            console.log('[qBittorrent] Настройки зарегистрированы');
        } catch (error) {
            console.error('[qBittorrent] Ошибка регистрации настроек:', error);
        }
    }

    // ================= ПУНКТ МЕНЮ =================

    function addMenuItem() {
        try {
            if (
                !window.Lampa ||
                !Lampa.Menu ||
                typeof Lampa.Menu.addButton !== 'function'
            ) {
                console.error('[qBittorrent] Lampa.Menu.addButton недоступен');
                return;
            }

            var icon =
                '<svg viewBox="0 0 24 24" width="24" height="24">' +
                '<path fill="currentColor" d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>';

            Lampa.Menu.addButton(icon, 'qBittorrent', function () {
                Lampa.Controller.toggle('settings');

                setTimeout(function () {
                    var item = document.querySelector(
                        '[data-component="qbit_direct"]'
                    );

                    if (item) item.click();
                }, 100);
            });

            console.log('[qBittorrent] Пункт меню добавлен');
        } catch (error) {
            console.error(
                '[qBittorrent] Ошибка добавления пункта меню:',
                error
            );
        }
    }

    // ================= КНОПКИ В КАРТОЧКЕ =================

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

            if (!item || item.querySelector('.qbit-direct-actions')) return;

            var magnet = data.MagnetUri || data.magnetUri || '';
            var title = data.Title || data.title || '';

            if (DEBUG) {
                console.log('[qBittorrent] torrent card data:', data);
            }

            var actions = document.createElement('div');
            actions.className = 'qbit-direct-actions';

            var addButton = createButton(
                'qbit-direct-add',
                '⬇ В qBittorrent',
                function () {
                    console.log('[qBittorrent] add press:', magnet);
                    qbAdd(magnet, title);
                }
            );

            var playerButton = createButton(
                'qbit-direct-player',
                '▶ Открыть плеер',
                function () {
                    handlePlayerButton();
                }
            );

            var deleteButton = createButton(
                'qbit-direct-delete',
                '🗑 Удалить',
                function () {
                    qbDelete(magnet);
                }
            );

            actions.appendChild(addButton);
            actions.appendChild(playerButton);
            actions.appendChild(deleteButton);

            item.appendChild(actions);
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
                    '.qbit-direct-actions{' +
                    'display:inline-flex;align-items:center;' +
                    'position:relative;z-index:999;' +
                    '}' +
                    '.qbit-direct-btn{' +
                    'display:inline-flex;align-items:center;' +
                    'justify-content:center;margin:8px;' +
                    'padding:10px 18px;background:#303638;' +
                    'color:white;border:2px solid #888;' +
                    'border-radius:6px;font-size:18px;' +
                    'white-space:nowrap;' +
                    '}' +
                    '.qbit-direct-btn.focus{' +
                    'border-color:white;background:#51595c;' +
                    '}' +
                    '.qbit-direct-player{' +
                    'background:#1f4b3a;border-color:#3fae7a;' +
                    '}' +
                    '.qbit-direct-player.focus{' +
                    'background:#2c6b51;' +
                    '}' +
                    '.qbit-direct-delete{' +
                    'background:#4b2323;border-color:#ae3f3f;' +
                    '}' +
                    '.qbit-direct-delete.focus{' +
                    'background:#6b2c2c;' +
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
