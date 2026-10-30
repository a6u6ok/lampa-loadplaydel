(function () {
    'use strict';

    if (window.torrserver_preload_ready) return;
    window.torrserver_preload_ready = true;

    var ACTION_LOCK_MS = 800;

    // ================= УТИЛИТЫ =================

    function notify(text) {
        try {
            if (window.Lampa && Lampa.Noty) { Lampa.Noty.show(text); return; }
        } catch (e) { console.error('[TorrServer Preload] notify:', e); }
        console.log('[TorrServer Preload]', text);
    }

    function storeGet(key, defaultValue) {
        try {
            if (window.Lampa && Lampa.Storage) {
                var v = Lampa.Storage.get(key, defaultValue);
                if (v !== undefined && v !== null) return v;
            }
        } catch (e) { console.error('[TorrServer Preload] storeGet:', e); }
        return defaultValue;
    }

    function getTorrServerUrl() {
        var one = storeGet('torrserver_url', '');
        var two = storeGet('torrserver_url_two', '');
        var useTwo = storeGet('torrserver_use_link', '') === 'two';
        return useTwo ? (two || one) : (one || two);
    }

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

    // ================= TORRSERVER =================

    function addTorrentToServer(magnetUri, title, onDone) {
        var url = getTorrServerUrl();
        if (!url) {
            notify('Сначала настройте адрес TorrServer');
            return;
        }

        if (!magnetUri || magnetUri.indexOf('magnet:') !== 0) {
            notify('У текущего торрента нет Magnet-ссылки');
            return;
        }

        notify('Добавление в TorrServer...');

        var payload = {
            action: 'add',
            link: magnetUri,
            title: '[LAMPA] ' + (title || 'Preload'),
            save_to_db: true
        };

        var network = new Lampa.Reguest();
        network.silent(
            url.replace(/\/$/, '') + '/torrents',
            function (data) {
                var hash = data && (data.hash || data.Hash);
                if (hash) {
                    notify('Предзагрузка запущена: ' + hash.slice(0, 8) + '...');
                    if (onDone) onDone(hash);
                } else {
                    notify('TorrServer не вернул Hash');
                }
            },
            function (err) {
                console.error('[TorrServer Preload]', err);
                notify('Ошибка предзагрузки, проверьте TorrServer');
            },
            JSON.stringify(payload),
            { headers: { 'Content-Type': 'application/json' }, timeout: 10000 }
        );
    }

    // ================= КНОПКА НА КАРТОЧКЕ =================

    function createButton(text, handler) {
        var button = document.createElement('div');
        button.className = 'ts-preload-btn selector';
        button.tabIndex = 0;
        button.textContent = text;
        bindPress(button, handler);
        return button;
    }

    function initTorrentButton() {
        if (!window.Lampa || !Lampa.Listener) {
            console.error('[TorrServer Preload] Lampa.Listener not available');
            return;
        }

        Lampa.Listener.follow('torrent', function (event) {
            if (!event || event.type !== 'render' || !event.item) return;

            var item = event.item.jquery ? event.item[0] : event.item;
            var data = event.element || {};

            if (!item || item.querySelector('.ts-preload-btn')) return;

            var magnet = data.MagnetUri || data.magnetUri || data.magnet || '';
            var title = data.Title || data.title || '';

            if (!magnet) return;

            var button = createButton('⬇ Предзагрузка', function () {
                addTorrentToServer(magnet, title, function (hash) {
                    button.textContent = '✔ В очереди';
                    button.classList.add('ts-preload-done');
                });
            });

            item.appendChild(button);
        });
    }

    // ================= СТИЛИ =================

    function addStyles() {
        if (document.getElementById('ts-preload-style')) return;
        var style = document.createElement('style');
        style.id = 'ts-preload-style';
        style.textContent =
            '.ts-preload-btn{display:inline-flex;align-items:center;justify-content:center;margin:8px;padding:10px 18px;background:#2a3a5a;color:white;border:2px solid #5a7ab0;border-radius:6px;font-size:18px;white-space:nowrap;}' +
            '.ts-preload-btn.focus{border-color:white;background:#3a5a8a;}' +
            '.ts-preload-btn.ts-preload-done{background:#1f4b3a;border-color:#3fae7a;pointer-events:none;opacity:0.9;}';
        document.head.appendChild(style);
    }

    // ================= ИНИЦИАЛИЗАЦИЯ =================

    function initializePlugin() {
        try {
            addStyles();
            initTorrentButton();
            console.log('[TorrServer Preload] Плагин загружен');
        } catch (e) {
            console.error('[TorrServer Preload] init:', e);
        }
    }

    if (window.Lampa && Lampa.Listener) {
        initializePlugin();
    } else {
        document.addEventListener('appready', initializePlugin);
    }
})();
