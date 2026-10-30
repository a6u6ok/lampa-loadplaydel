(function () {
    'use strict';

    // Предотвращение повторной загрузки
    if (window.torrserver_preload_ready) return;
    window.torrserver_preload_ready = true;

    // Получение адреса TorrServer (совместимо со встроенными настройками Lampa)
    function getTorrServerUrl() {
        var one = Lampa.Storage.get('torrserver_url');
        var two = Lampa.Storage.get('torrserver_url_two');
        var useTwo = Lampa.Storage.field('torrserver_use_link') === 'two';
        return useTwo ? (two || one) : (one || two);
    }

    // Отправка запроса к TorrServer
    function addTorrentToServer(magnetUri, title) {
        var url = getTorrServerUrl();
        if (!url) {
            Lampa.Noty.show('Сначала настройте адрес TorrServer');
            return;
        }

        // Проверка наличия Magnet-ссылки
        if (!magnetUri || magnetUri.indexOf('magnet:') !== 0) {
            Lampa.Noty.show('У текущего торрента нет Magnet-ссылки, невозможно выполнить предзагрузку');
            return;
        }

        Lampa.Noty.show('Добавление в TorrServer...');

        var payload = {
            action: 'add',
            link: magnetUri,
            title: '[LAMPA] ' + (title || 'Preload'),
            save_to_db: false
        };

        var network = new Lampa.Reguest();
        network.silent(
            url.replace(/\/$/, '') + '/torrents',
            function (data) {
                if (data && data.hash) {
                    Lampa.Noty.show('Предзагрузка запущена, Hash: ' + data.hash.slice(0, 8) + '...');
                } else {
                    Lampa.Noty.show('TorrServer не вернул Hash, проверьте журнал');
                }
            },
            function (err) {
                console.error('[TorrServer Preload]', err);
                Lampa.Noty.show('Ошибка предзагрузки, проверьте подключение к TorrServer');
            },
            JSON.stringify(payload),
            { headers: { 'Content-Type': 'application/json' }, timeout: 10000 }
        );
    }

    // Регистрация пункта контекстного меню карточки
    Lampa.Manifest.plugins = {
        type: 'video',
        onContextMenu: function (card) {
            // Отображение только при наличии Magnet-ссылки (обычно на странице сведений о торренте)
            if (card.MagnetUri || card.magnet) {
                return { title: 'Предзагрузка в TorrServer' };
            }
            return null;
        },
        onContextLaunch: function (card) {
            // Совместимость с различными полями: MagnetUri или magnet
            var magnet = card.MagnetUri || card.magnet;
            var title = card.Title || card.title || 'Unknown';
            addTorrentToServer(magnet, title);
        }
    };

    console.log('[TorrServer Preload] Плагин загружен');
})();
