
(function () {
    'use strict';

    var PLUGIN_NAME = 'qbit_add';
    var DEFAULTS = {
        host: 'http://192.168.1.1:9080',
        username: '',
        password: '',
        bypass: true,
        savepath: '/opt/download/download',
        category: '',
        rename: true
    };

    var settings = {};
    var addedButtons = [];

    function getSetting(name) {
        try {
            var value = Lampa.Storage.get(PLUGIN_NAME + '_' + name);
            return value === undefined || value === null
                ? DEFAULTS[name]
                : value;
        } catch (e) {
            return DEFAULTS[name];
        }
    }

    function loadSettings() {
        Object.keys(DEFAULTS).forEach(function (key) {
            settings[key] = getSetting(key);
        });

        settings.host = String(settings.host || '').replace(/\/+$/, '');
    }

    function saveSetting(name, value) {
        settings[name] = value;
        Lampa.Storage.set(PLUGIN_NAME + '_' + name, value);
    }

    function notify(message) {
        if (Lampa.Noty && Lampa.Noty.show) {
            Lampa.Noty.show(message);
        }
    }

    function nativeRequest(options, callback) {
        var completed = false;

        function finish(result) {
            if (completed) return;
            completed = true;
            callback(result);
        }

        if (window.AndroidJS &&
            typeof window.AndroidJS.httpReq === 'function') {

            try {
                window.AndroidJS.httpReq(JSON.stringify({
                    url: options.url,
                    method: options.method || 'GET',
                    headers: options.headers || {},
                    data: options.data || ''
                }));

                var attempts = 0;

                var timer = setInterval(function () {
                    attempts++;

                    try {
                        var response = window.AndroidJS.getResp();

                        if (response) {
                            clearInterval(timer);
                            finish(response);
                        }
                    } catch (e) {}

                    if (attempts >= 30) {
                        clearInterval(timer);
                        finish(null);
                    }
                }, 200);

                return;
            } catch (e) {}
        }

        if (typeof fetch === 'function') {
            fetch(options.url, {
                method: options.method || 'GET',
                headers: options.headers || {},
                body: options.data || undefined,
                credentials: 'include'
            }).then(function (response) {
                return response.text();
            }).then(function (text) {
                finish(text);
            }).catch(function () {
                finish(null);
            });

            return;
        }

        finish(null);
    }

    function request(url, method, data, callback) {
        nativeRequest({
            url: settings.host + url,
            method: method,
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            data: data || ''
        }, callback);
    }

    function encode(data) {
        return Object.keys(data).map(function (key) {
            return encodeURIComponent(key) + '=' +
                encodeURIComponent(data[key] == null ? '' : data[key]);
        }).join('&');
    }

    function addTorrent(magnet, title, callback) {
        function sendAdd() {
            var data = {
                urls: magnet,
                savepath: settings.savepath,
                rename: settings.rename ? title : ''
            };

            if (settings.category) {
                data.category = settings.category;
            }

            request(
                '/api/v2/torrents/add',
                'POST',
                encode(data),
                function (response) {
                    callback(response);
                }
            );
        }

        if (settings.bypass) {
            sendAdd();
            return;
        }

        request('/api/v2/auth/login', 'POST', encode({
            username: settings.username,
            password: settings.password
        }), function (response) {
            if (response && String(response).indexOf('Ok.') !== -1) {
                sendAdd();
            } else {
                callback(null);
            }
        });
    }

    function getMagnet(element) {
        if (!element) return '';

        var fields = [
            'MagnetUri',
            'magnetUri',
            'magnet',
            'Magnet',
            'magnet_link',
            'MagnetLink'
        ];

        for (var i = 0; i < fields.length; i++) {
            var value = element[fields[i]];

            if (typeof value === 'string' &&
                value.indexOf('magnet:?') === 0) {
                return value;
            }
        }

        if (element.torrent) {
            return getMagnet(element.torrent);
        }

        return '';
    }

    function getTitle(element) {
        if (!element) return 'Lampa torrent';

        return element.Title ||
            element.title ||
            element.name ||
            element.Name ||
            'Lampa torrent';
    }

    function createButton() {
        var button = document.createElement('div');

        button.className = 'qbit-add-button';
        button.innerHTML =
            '<span style="font-size:18px;margin-right:6px">⬇</span>' +
            '<span>qBittorrent</span>';

        button.style.cssText = [
            'display:flex',
            'align-items:center',
            'justify-content:center',
            'white-space:nowrap',
            'padding:9px 13px',
            'border-radius:6px',
            'background:#263b50',
            'color:#fff',
            'font-size:14px',
            'font-weight:500',
            'cursor:pointer',
            'box-sizing:border-box',
            'min-height:38px',
            'z-index:20'
        ].join(';');

        return button;
    }

    function addTorrentButton(event) {
        if (!event || !event.item || !event.element) return;

        var item = event.item;
        var element = event.element;

        if (item.querySelector('.qbit-add-button')) return;

        var magnet = getMagnet(element);

        if (!magnet) return;

        var title = getTitle(element);

        // Карточка становится опорным контейнером.
        item.style.position = 'relative';

        // Резервируем место справа, чтобы кнопка не перекрывала текст.
        item.style.paddingRight = '145px';
        item.style.boxSizing = 'border-box';

        var button = createButton();

        // Кнопка располагается справа по центру строки.
        button.style.position = 'absolute';
        button.style.right = '10px';
        button.style.top = '50%';
        button.style.transform = 'translateY(-50%)';

        button.addEventListener('click', function (e) {
            e.preventDefault();
            e.stopPropagation();

            if (button.dataset.loading === '1') return;

            button.dataset.loading = '1';
            button.style.opacity = '0.6';
            button.innerHTML = 'Добавление...';

            addTorrent(magnet, title, function (response) {
                button.dataset.loading = '0';
                button.style.opacity = '1';

                if (response && String(response).trim() === 'Ok.') {
                    button.innerHTML = '✓ Добавлено';
                    notify('Торрент отправлен в qBittorrent');

                    setTimeout(function () {
                        button.innerHTML =
                            '<span style="font-size:18px;margin-right:6px">⬇</span>' +
                            '<span>qBittorrent</span>';
                    }, 2500);
                } else {
                    button.innerHTML = 'Ошибка';
                    notify('Не удалось добавить торрент в qBittorrent');

                    setTimeout(function () {
                        button.innerHTML =
                            '<span style="font-size:18px;margin-right:6px">⬇</span>' +
                            '<span>qBittorrent</span>';
                    }, 2500);
                }
            });
        });

        item.appendChild(button);
    }

    function initSettings() {
        if (!Lampa.SettingsApi) return;

        Lampa.SettingsApi.addComponent({
            component: 'qbit_add',
            name: 'qBittorrent'
        });

        Lampa.SettingsApi.addParam({
            component: 'qbit_add',
            param: {
                name: 'qbit_add_host',
                type: 'input',
                default: DEFAULTS.host
            },
            field: {
                name: 'Адрес qBittorrent',
                description: 'Например: http://192.168.1.1:9080'
            },
            onChange: function (value) {
                saveSetting('host', value);
                settings.host = String(value || '').replace(/\/+$/, '');
            }
        });

        Lampa.SettingsApi.addParam({
            component: 'qbit_add',
            param: {
                name: 'qbit_add_username',
                type: 'input',
                default: DEFAULTS.username
            },
            field: {
                name: 'Логин'
            },
            onChange: function (value) {
                saveSetting('username', value);
            }
        });

        Lampa.SettingsApi.addParam({
            component: 'qbit_add',
            param: {
                name: 'qbit_add_password',
                type: 'input',
                default: DEFAULTS.password
            },
            field: {
                name: 'Пароль'
            },
            onChange: function (value) {
                saveSetting('password', value);
            }
        });

        Lampa.SettingsApi.addParam({
            component: 'qbit_add',
            param: {
                name: 'qbit_add_bypass',
                type: 'trigger',
                default: DEFAULTS.bypass
            },
            field: {
                name: 'Авторизация отключена'
            },
            onChange: function (value) {
                saveSetting('bypass', value);
            }
        });

        Lampa.SettingsApi.addParam({
            component: 'qbit_add',
            param: {
                name: 'qbit_add_savepath',
                type: 'input',
                default: DEFAULTS.savepath
            },
            field: {
                name: 'Папка загрузки'
            },
            onChange: function (value) {
                saveSetting('savepath', value);
            }
        });

        Lampa.SettingsApi.addParam({
            component: 'qbit_add',
            param: {
                name: 'qbit_add_category',
                type: 'input',
                default: DEFAULTS.category
            },
            field: {
                name: 'Категория qBittorrent'
            },
            onChange: function (value) {
                saveSetting('category', value);
            }
        });

        Lampa.SettingsApi.addParam({
            component: 'qbit_add',
            param: {
                name: 'qbit_add_rename',
                type: 'trigger',
                default: DEFAULTS.rename
            },
            field: {
                name: 'Переименовывать торрент по названию'
            },
            onChange: function (value) {
                saveSetting('rename', value);
            }
        });
    }

    function startPlugin() {
        loadSettings();
        initSettings();

        Lampa.Listener.follow('torrent', function (event) {
            if (event.type === 'render') {
                addTorrentButton(event);
            }
        });
    }

    if (window.Lampa && Lampa.Listener) {
        startPlugin();
    } else {
        document.addEventListener('lampa:ready', startPlugin);
    }
})();
