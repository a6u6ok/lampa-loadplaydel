
(function () {
    'use strict';

    var FLAG = '__lampa_qbittorrent_sender';
    if (window[FLAG]) return;
    window[FLAG] = true;

    function init() {
        var L = window.Lampa;

        var SETTINGS = {
            server: 'qbt_server',
            login: 'qbt_login',
            password: 'qbt_password',
            savepath: 'qbt_savepath',
            category: 'qbt_category'
        };

        // -------------------------
        // Настройки
        // -------------------------

        function field(name) {
            return String(L.Storage.field(name) || '').trim();
        }

        function config() {
            return {
                server: field(SETTINGS.server).replace(/\/+$/, ''),
                login: field(SETTINGS.login),
                password: String(L.Storage.get(SETTINGS.password, '') || ''),
                savepath: field(SETTINGS.savepath),
                category: field(SETTINGS.category)
            };
        }

        L.SettingsApi.addComponent({
            component: 'qbt_sender',
            name: 'qBittorrent',
            icon: '<svg viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2"><path d="M12 3v12m-5-5 5 5 5-5M4 17v4h16v-4"/></svg>'
        });

        function addSetting(name, title, placeholder, def) {
            L.SettingsApi.addParam({
                component: 'qbt_sender',
                param: {
                    name: name,
                    type: 'input',
                    values: 'string',
                    default: def || '',
                    placeholder: placeholder || ''
                },
                field: {
                    name: title
                }
            });
        }

        addSetting(
            SETTINGS.server,
            'Адрес qBittorrent WebUI',
            'http://192.168.1.1:8080'
        );

        addSetting(
            SETTINGS.login,
            'Логин qBittorrent',
            'admin'
        );

        // Пароль сохраняется отдельно
        addSetting(
            'qbt_password_input',
            'Пароль qBittorrent',
            'Введите пароль'
        );

        // Скрываем сохранённый пароль из обычного поля
        L.SettingsApi.addParam({
            component: 'qbt_sender',
            param: {
                name: 'qbt_password_input',
                type: 'input',
                values: 'string',
                default: '',
                placeholder: 'Новый пароль'
            },
            field: {
                name: 'Изменить пароль',
                description: 'Пустое значение не меняет сохранённый пароль'
            },
            onChange: function (value) {
                if (value) {
                    L.Storage.set(SETTINGS.password, value);
                }
                L.Storage.set('qbt_password_input', '');
            }
        });

        addSetting(
            SETTINGS.savepath,
            'Папка загрузки на SSD',
            '/opt/storage/downloads'
        );

        addSetting(
            SETTINGS.category,
            'Категория',
            'Lampa'
        );

        // -------------------------
        // Уведомления
        // -------------------------

        function notify(message, style) {
            L.Noty.show(message, style ? { style: style } : {});
        }

        // -------------------------
        // HTTP запросы
        // -------------------------

        function request(method, url, body, callback) {
            var xhr = new XMLHttpRequest();

            xhr.open(method, url, true);
            xhr.timeout = 15000;
            xhr.withCredentials = true;

            if (body instanceof FormData) {
                xhr.send(body);
            } else if (body) {
                xhr.setRequestHeader(
                    'Content-Type',
                    'application/x-www-form-urlencoded'
                );
                xhr.send(body);
            } else {
                xhr.send();
            }

            xhr.onload = function () {
                callback(xhr.status, xhr.responseText, xhr);
            };

            xhr.onerror = function () {
                callback(0, '', xhr);
            };

            xhr.ontimeout = function () {
                callback(0, '', xhr);
            };
        }

        function encode(data) {
            var result = [];

            Object.keys(data).forEach(function (key) {
                if (data[key] !== undefined && data[key] !== null) {
                    result.push(
                        encodeURIComponent(key) + '=' +
                        encodeURIComponent(data[key])
                    );
                }
            });

            return result.join('&');
        }

        // -------------------------
        // Авторизация
        // -------------------------

        function login(callback) {
            var c = config();

            if (!c.server || !c.login || !c.password) {
                notify('Заполните настройки qBittorrent', 'error');
                return;
            }

            request(
                'POST',
                c.server + '/api/v2/auth/login',
                encode({
                    username: c.login,
                    password: c.password
                }),
                function (status, response) {
                    if (status === 200 && response.trim() === 'Ok.') {
                        callback(true);
                    } else {
                        callback(false);
                    }
                }
            );
        }

        // -------------------------
        // Добавление торрента
        // -------------------------

        function addTorrent(link, title) {
            var c = config();

            if (!c.server) {
                notify('Не указан адрес qBittorrent', 'error');
                return;
            }

            if (!link) {
                notify('Ссылка на торрент не найдена', 'error');
                return;
            }

            notify('Подключение к qBittorrent...');

            login(function (success) {
                if (!success) {
                    notify(
                        'Ошибка авторизации qBittorrent',
                        'error'
                    );
                    return;
                }

                var data = new FormData();

                data.append('urls', link);

                if (c.savepath) {
                    data.append('savepath', c.savepath);
                }

                if (c.category) {
                    data.append('category', c.category);
                }

                data.append('paused', 'false');

                request(
                    'POST',
                    c.server + '/api/v2/torrents/add',
                    data,
                    function (status, response) {
                        if (status === 200 && response.trim() === 'Ok.') {
                            notify(
                                'Торрент отправлен в qBittorrent: ' +
                                (title || ''),
                                'success'
                            );
                        } else {
                            notify(
                                'Не удалось добавить торрент. HTTP: ' +
                                status,
                                'error'
                            );
                        }
                    }
                );
            });
        }

        // -------------------------
        // Получение ссылки
        // -------------------------

        function getMagnet(element) {
            if (!element) return '';

            if (element.MagnetUri) {
                return element.MagnetUri;
            }

            if (/^magnet:/i.test(element.Link || '')) {
                return element.Link;
            }

            if (/^https?:\/\//i.test(element.Link || '') &&
                /\.torrent(?:[?#]|$)/i.test(element.Link)) {
                return element.Link;
            }

            if (element.magnet) {
                return element.magnet;
            }

            return '';
        }

        function getTitle(element) {
            return element
                ? String(
                    element.Title ||
                    element.title ||
                    element.name ||
                    element.path_human ||
                    ''
                )
                : '';
        }

        // -------------------------
        // Добавление кнопки
        // -------------------------

        function addMenu(menu, previous, link, title) {
            if (!link || !menu) return;

            menu.push({
                title: 'Скачать в qBittorrent',

                onSelect: function () {
                    addTorrent(link, title);

                    if (previous) {
                        L.Controller.toggle(previous);
                    }
                }
            });
        }

        // Список торрент-раздач
        L.Listener.follow('torrent', function (e) {
            if (
                e.type !== 'onlong' ||
                !e.menu ||
                !e.element
            ) return;

            var element = e.element;
            var previous = L.Controller.enabled().name;

            addMenu(
                e.menu,
                previous,
                getMagnet(element),
                getTitle(element)
            );
        });

        // Файлы внутри торрент-раздачи
        L.Listener.follow('torrent_file', function (e) {
            if (
                e.type !== 'onlong' ||
                !e.menu ||
                !e.element
            ) return;

            var element = e.element;
            var previous = L.Controller.enabled().name;

            var link = '';

            if (element.torrent_hash) {
                link = 'magnet:?xt=urn:btih:' +
                    element.torrent_hash;
            }

            addMenu(
                e.menu,
                previous,
                link,
                getTitle(element)
            );
        });

        notify('qBittorrent Sender загружен', 'success');
    }

    if (window.appready) {
        init();
    } else {
        Lampa.Listener.follow('app', function (e) {
            if (e.type === 'ready') init();
        });
    }
})();
