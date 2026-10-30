
(function () {
    'use strict';

    // =====================================================
    // qBittorrent для Lampa
    // Постоянная кнопка добавления возле каждой раздачи
    // =====================================================

    var DEF_URL = 'http://192.168.1.1:9080';
    var DEF_USER = '';
    var DEF_PASS = '';
    var DEF_BYPASS = true;
    var DEF_SAVEPATH = '/opt/download/download';
    var DEF_CATEGORY = '';
    var DEF_RENAME = true;

    var DEBUG = true;
    var ACTION_LOCK_MS = 1000;

    var CT_FORM = {
        'Content-Type': 'application/x-www-form-urlencoded'
    };

    // =====================================================
    // УВЕДОМЛЕНИЯ
    // =====================================================

    function notify(message) {
        try {
            if (window.Lampa && Lampa.Noty) {
                Lampa.Noty.show(message);
                return;
            }
        } catch (e) {}

        console.log('[qBittorrent]', message);
    }

    function log() {
        if (DEBUG) {
            console.log.apply(console, ['[qBittorrent]'].concat(
                Array.prototype.slice.call(arguments)
            ));
        }
    }

    // =====================================================
    // НАСТРОЙКИ
    // =====================================================

    function storeGet(key, defaultValue) {
        try {
            if (window.Lampa && Lampa.Storage) {
                var value = Lampa.Storage.get(key, defaultValue);

                if (value !== undefined && value !== null) {
                    return value;
                }
            }
        } catch (e) {
            console.error('[qBittorrent] Storage error:', e);
        }

        return defaultValue;
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
            bypass: isTrue(
                storeGet('qbit_bypass', DEF_BYPASS),
                DEF_BYPASS
            ),
            savepath: storeGet('qbit_savepath', DEF_SAVEPATH),
            category: storeGet('qbit_category', DEF_CATEGORY),
            rename: isTrue(
                storeGet('qbit_rename', DEF_RENAME),
                DEF_RENAME
            )
        };
    }

    function base() {
        return String(cfg().url || '').replace(/\/+$/, '');
    }

    // =====================================================
    // HTTP ЗАПРОСЫ
    // =====================================================

    function fetchRequest(request, callback) {
        if (typeof fetch !== 'function') {
            callback(null);
            return;
        }

        var options = {
            method: request.method || 'GET',
            headers: request.headers || {},
            credentials: 'include'
        };

        if (request.body) {
            options.body = request.body;
        }

        fetch(request.url, options)
            .then(function (response) {
                return response.text();
            })
            .then(function (text) {
                callback(text);
            })
            .catch(function (error) {
                console.error('[qBittorrent] Fetch error:', error);
                callback(null);
            });
    }

    function nativeRequest(request, callback) {
        var responded = false;

        function finish(response) {
            if (responded) return;
            responded = true;

            if (response === null || response === undefined) {
                callback(null);
                return;
            }

            callback(String(response));
        }

        if (!window.AndroidJS ||
            typeof AndroidJS.httpReq !== 'function') {
            fetchRequest(request, callback);
            return;
        }

        try {
            try {
                AndroidJS.getResp();
            } catch (e) {}

            AndroidJS.httpReq(JSON.stringify(request));

        } catch (error) {
            console.error('[qBittorrent] AndroidJS error:', error);
            fetchRequest(request, callback);
            return;
        }

        var tries = 0;
        var maxTries = 30;

        function poll() {
            if (responded) return;

            tries++;

            var response = null;

            try {
                response = AndroidJS.getResp();
            } catch (e) {
                console.error('[qBittorrent] getResp error:', e);
            }

            if (typeof response === 'string' &&
                response.length > 0) {
                finish(response);
                return;
            }

            if (tries >= maxTries) {
                console.error('[qBittorrent] Request timeout');
                finish(null);
                return;
            }

            setTimeout(poll, 150);
        }

        setTimeout(poll, 150);
    }

    // =====================================================
    // ФОРМИРОВАНИЕ ЗАПРОСА
    // =====================================================

    function buildAddBody(magnet, title) {
        var config = cfg();

        var params = {
            urls: magnet,
            paused: 'false'
        };

        if (config.savepath) {
            params.savepath = config.savepath;
        }

        if (config.category) {
            params.category = config.category;
        }

        if (config.rename && title) {
            params.rename = title;
        }

        return Object.keys(params).map(function (key) {
            return encodeURIComponent(key) + '=' +
                encodeURIComponent(params[key]);
        }).join('&');
    }

    // =====================================================
    // ДОБАВЛЕНИЕ ТОРРЕНТА
    // =====================================================

    function qbAdd(magnet, title, callback) {
        if (!magnet || !/^magnet:\?/i.test(magnet)) {
            notify('У этой раздачи нет magnet-ссылки');
            return;
        }

        var config = cfg();

        var body = buildAddBody(magnet, title);

        notify('Отправляю торрент в qBittorrent...');

        function finishAdd(response) {
            log('Add response:', response);

            if (response === null) {
                notify('Ошибка соединения с qBittorrent');
                return;
            }

            var result = String(response).trim();

            if (/forbidden|403|unauthorized/i.test(result)) {
                notify('Ошибка авторизации qBittorrent');
                return;
            }

            if (result === 'Ok.') {
                notify('Торрент добавлен в qBittorrent');

                if (callback) callback(true);
                return;
            }

            if (/fails/i.test(result)) {
                notify('qBittorrent не принял торрент');
                return;
            }

            notify('Ответ qBittorrent: ' + result);
        }

        function addRequest() {
            nativeRequest({
                url: base() + '/api/v2/torrents/add',
                method: 'POST',
                body: body,
                headers: CT_FORM
            }, finishAdd);
        }

        if (!config.bypass && config.user) {
            nativeRequest({
                url: base() + '/api/v2/auth/login',
                method: 'POST',
                body:
                    'username=' + encodeURIComponent(config.user) +
                    '&password=' + encodeURIComponent(config.pass),
                headers: CT_FORM
            }, function (response) {
                if (response === null ||
                    /Fails|Forbidden|403/i.test(response)) {
                    notify('Не удалось войти в qBittorrent');
                    return;
                }

                addRequest();
            });
        } else {
            addRequest();
        }
    }

    // =====================================================
    // ПОЛУЧЕНИЕ MAGNET И НАЗВАНИЯ
    // =====================================================

    function getMagnet(data) {
        if (!data) return '';

        var fields = [
            data.MagnetUri,
            data.magnetUri,
            data.magnet,
            data.Magnet,
            data.magnet_link,
            data.MagnetLink
        ];

        for (var i = 0; i < fields.length; i++) {
            if (typeof fields[i] === 'string' &&
                /^magnet:\?/i.test(fields[i])) {
                return fields[i].trim();
            }
        }

        return '';
    }

    function getTitle(data) {
        if (!data) return '';

        return String(
            data.Title ||
            data.title ||
            data.name ||
            data.Name ||
            ''
        ).trim();
    }

    // =====================================================
    // КНОПКИ
    // =====================================================

    function bindPress(element, handler) {
        var lastAction = 0;

        function wrapped(event) {
            var now = Date.now();

            if (now - lastAction < ACTION_LOCK_MS) return;

            lastAction = now;

            if (event) {
                event.preventDefault();
                event.stopPropagation();

                if (event.stopImmediatePropagation) {
                    event.stopImmediatePropagation();
                }
            }

            handler();
        }

        element.addEventListener('hover:enter', wrapped);
        element.addEventListener('click', wrapped);
    }

    function createButton(magnet, title) {
        var button = document.createElement('div');

        button.className =
            'qbit-add-button selector';

        button.tabIndex = 0;
        button.textContent = '⬇ qBittorrent';

        if (!magnet) {
            button.classList.add('qbit-no-magnet');
            button.textContent = 'Нет magnet';
            return button;
        }

        var busy = false;

        bindPress(button, function () {
            if (busy) return;

            busy = true;

            button.classList.add('qbit-loading');
            button.textContent = '⏳ Отправка...';

            qbAdd(magnet, title, function () {
                button.classList.remove('qbit-loading');
                button.classList.add('qbit-success');
                button.textContent = '✓ Добавлено';

                setTimeout(function () {
                    button.classList.remove('qbit-success');
                    button.textContent = '⬇ qBittorrent';
                    busy = false;
                }, 3000);
            });

            // Разрешаем повторную попытку при ошибке
            setTimeout(function () {
                if (!button.classList.contains('qbit-success')) {
                    button.classList.remove('qbit-loading');
                    button.textContent = '⬇ qBittorrent';
                    busy = false;
                }
            }, 10000);
        });

        return button;
    }

    // =====================================================
    // ВСТАВКА КНОПКИ В КАЖДУЮ РАЗДАЧУ
    // =====================================================

    function initTorrentButton() {
        if (!window.Lampa || !Lampa.Listener) {
            console.error('[qBittorrent] Listener unavailable');
            return;
        }

        Lampa.Listener.follow('torrent', function (event) {
            if (!event || event.type !== 'render') return;
            if (!event.item) return;

            var item = event.item.jquery
                ? event.item[0]
                : event.item;

            if (!item) return;

            if (item.querySelector('.qbit-add-button')) {
                return;
            }

            var data = event.element || {};

            var magnet = getMagnet(data);
            var title = getTitle(data);

            var button = createButton(magnet, title);

            var actions = document.createElement('div');
            actions.className = 'qbit-add-actions';

            actions.appendChild(button);
            item.appendChild(actions);

            log('Torrent button added:', title, !!magnet);
        });
    }

    // =====================================================
    // НАСТРОЙКИ LAMPA
    // =====================================================

    function registerSettings() {
        if (!window.Lampa || !Lampa.SettingsApi) {
            console.error('[qBittorrent] SettingsApi unavailable');
            return;
        }

        Lampa.SettingsApi.addComponent({
            component: 'qbit_add',
            name: 'qBittorrent',
            icon:
                '<svg viewBox="0 0 24 24" width="24" height="24">' +
                '<path fill="currentColor" d="' +
                'M12 2L3 13h7l-1 9 12-13h-7l1-7z"/>' +
                '</svg>'
        });

        function addParam(name, type, value, title, description) {
            Lampa.SettingsApi.addParam({
                component: 'qbit_add',
                param: {
                    name: name,
                    type: type,
                    values: type === 'input' ? '' : undefined,
                    default: value
                },
                field: {
                    name: title,
                    description: description || ''
                }
            });
        }

        addParam(
            'qbit_url',
            'input',
            DEF_URL,
            'Адрес qBittorrent',
            'Например: http://192.168.1.1:9080'
        );

        addParam(
            'qbit_user',
            'input',
            DEF_USER,
            'Логин',
            'Логин Web UI'
        );

        addParam(
            'qbit_pass',
            'input',
            DEF_PASS,
            'Пароль',
            'Пароль Web UI'
        );

        addParam(
            'qbit_bypass',
            'trigger',
            DEF_BYPASS,
            'Обход авторизации',
            'Включить, если авторизация отключена'
        );

        addParam(
            'qbit_savepath',
            'input',
            DEF_SAVEPATH,
            'Папка загрузки',
            'Путь на роутере, например /opt/download/download'
        );

        addParam(
            'qbit_category',
            'input',
            DEF_CATEGORY,
            'Категория',
            'Необязательно'
        );

        addParam(
            'qbit_rename',
            'trigger',
            DEF_RENAME,
            'Переименовывать торрент',
            'Использовать название раздачи'
        );

        log('Settings registered');
    }

    // =====================================================
    // ПУНКТ В МЕНЮ LAMPA
    // =====================================================

    function addMenuItem() {
        try {
            if (!window.Lampa ||
                !Lampa.Menu ||
                typeof Lampa.Menu.addButton !== 'function') {
                return;
            }

            var icon =
                '<svg viewBox="0 0 24 24" width="24" height="24">' +
                '<path fill="currentColor" d="' +
                'M12 2L3 13h7l-1 9 12-13h-7l1-7z"/>' +
                '</svg>';

            Lampa.Menu.addButton(icon, 'qBittorrent', function () {
                Lampa.Controller.toggle('settings');

                setTimeout(function () {
                    var item = document.querySelector(
                        '[data-component="qbit_add"]'
                    );

                    if (item) item.click();
                }, 100);
            });

        } catch (error) {
            console.error('[qBittorrent] Menu error:', error);
        }
    }

    // =====================================================
    // СТИЛИ
    // =====================================================

    function installStyles() {
        if (document.getElementById('qbit-add-style')) return;

        var style = document.createElement('style');
        style.id = 'qbit-add-style';

        style.textContent =
            '.qbit-add-actions{' +
                'display:flex;' +
                'align-items:center;' +
                'position:relative;' +
                'z-index:999;' +
                'width:100%;' +
                'flex-wrap:wrap;' +
            '}' +

            '.qbit-add-button{' +
                'display:inline-flex;' +
                'align-items:center;' +
                'justify-content:center;' +
                'margin:8px;' +
                'padding:10px 18px;' +
                'min-height:38px;' +
                'background:#24583f;' +
                'color:#fff;' +
                'border:2px solid #45a978;' +
                'border-radius:7px;' +
                'font-size:17px;' +
                'font-weight:bold;' +
                'white-space:nowrap;' +
                'cursor:pointer;' +
            '}' +

            '.qbit-add-button.focus{' +
                'background:#347c59;' +
                'border-color:#fff;' +
            '}' +

            '.qbit-add-button.qbit-loading{' +
                'background:#555;' +
                'opacity:.75;' +
            '}' +

            '.qbit-add-button.qbit-success{' +
                'background:#247a43;' +
                'border-color:#69d68e;' +
            '}' +

            '.qbit-add-button.qbit-no-magnet{' +
                'background:#555;' +
                'border-color:#777;' +
                'opacity:.5;' +
            '}';

        document.head.appendChild(style);
    }

    // =====================================================
    // ИНИЦИАЛИЗАЦИЯ
    // =====================================================

    function initializePlugin() {
        if (window.qbit_add_initialized) return;

        window.qbit_add_initialized = true;

        log('Initializing...');

        installStyles();
        registerSettings();
        addMenuItem();
        initTorrentButton();

        log('Plugin loaded');
        notify('Плагин qBittorrent загружен');
    }

    if (window.Lampa && Lampa.Listener) {
        initializePlugin();
    } else {
        document.addEventListener('appready', function () {
            initializePlugin();
        });
    }

})();
