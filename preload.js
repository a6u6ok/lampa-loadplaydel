(function () {
  'use strict';

  // ================= НАСТРОЙКИ =================
  var QB_URL = 'http://192.168.1.1:9080';
  var QB_USER = 'admin';
  var QB_PASS = 'password'; // !!! ОБЯЗАТЕЛЬНО ЗАМЕНИ НА СВОЙ ПАРОЛЬ !!!
  // Путь на диске роутера (Entware) — узнай через df -h / lsblk и поставь сюда
  var savePath = '/mnt/sda1/downloads';
  // ============================================

  /**
   * Получает CSRF‑токен от qBittorrent API
   */
  function getQbToken(cb) {
    var xhr = new XMLHttpRequest();
    xhr.open('GET', QB_URL + '/api/v2/auth/csrfToken', true);
    xhr.setRequestHeader('Authorization', 'Basic ' + btoa(QB_USER + ':' + QB_PASS));

    xhr.onload = function () {
      if (xhr.status === 200) {
        cb(xhr.responseText);
      } else {
        console.error('qBittorrent token error', xhr.status, xhr.responseText);
        cb(null);
      }
    };
    xhr.onerror = function () { cb(null); };
    xhr.send();
  }

  /**
   * Отправляет magnet или .torrent URL в qBittorrent
   */
  function addTorrentToQb(link, cb) {
    getQbToken(function (token) {
      if (!token) {
        cb('Не удалось получить CSRF‑токен (проверь логин/пароль и доступность API)');
        return;
      }

      var formData = new FormData();
      formData.append('urls', link);
      formData.append('save_path', savePath);

      var xhr = new XMLHttpRequest();
      xhr.open('POST', QB_URL + '/api/v2/torrents/add', true);
      xhr.setRequestHeader('X-CSRF-Token', token);
      xhr.setRequestHeader('Authorization', 'Basic ' + btoa(QB_USER + ':' + QB_PASS));

      xhr.onload = function () {
        if (xhr.status >= 200 && xhr.status < 300) {
          cb(null);
        } else {
          cb('Ошибка qBittorrent: ' + xhr.status + ' ' + xhr.responseText);
        }
      };
      xhr.onerror = function () { cb('Ошибка сети (недоступен роутер или порт)'); };
      xhr.send(formData);
    });
  }

  /**
   * Создаёт кнопку на карточке и вешает обработчик
   * cardEl: DOM‑элемент карточки
   * magnetLink: magnet‑ссылка (или .torrent URL)
   */
  function injectQbButton(cardEl, magnetLink) {
    if (!cardEl || !magnetLink) return;

    // Не создаём кнопку дважды
    var existing = cardEl.querySelector('[data-qb-btn]');
    if (existing) return;

    var btn = document.createElement('button');
    btn.innerText = 'qBittorrent';
    btn.className = 'button-style'; // если в Lampa есть такой класс — будет красиво
    btn.setAttribute('data-qb-btn', '1');
    // Простые стили, чтобы кнопка была видна даже без классов Lampa
    btn.style.margin = '4px 4px 0 0';
    btn.style.padding = '6px 12px';
    btn.style.fontSize = '13px';
    btn.style.cursor = 'pointer';

    btn.onclick = function (e) {
      e.preventDefault();
      e.stopPropagation();

      btn.innerText = 'Отправка...';
      btn.disabled = true;

      addTorrentToQb(magnetLink, function (err) {
        if (err) {
          alert('Ошибка: ' + err);
          console.error(err);
        } else {
          alert('Торрент отправлен в qBittorrent');
        }
        btn.innerText = 'qBittorrent';
        btn.disabled = false;
      });
    };

    // Ищем блок действий. Если нет — кнопка встанет в конец карточки.
    var actionsBlock = cardEl.querySelector('.card-actions') || cardEl;
    actionsBlock.appendChild(btn);
  }

  /**
   * Пытается вытащить magnet‑ссылку из карточки.
   * Это эвристика: зависит от того, как плагин хранит данные.
   * Если у тебя есть доступ к объекту данных — лучше передавать его явно.
   */
  function extractMagnetFromCard(cardEl) {
    // Вариант 1: ищем ссылку в data‑атрибутах (частый случай в плагинах)
    var magnet = cardEl.getAttribute('data-magnet');
    if (magnet) return magnet;

    // Вариант 2: ищем в data-url (если ссылка на .torrent)
    var url = cardEl.getAttribute('data-url');
    if (url) return url;

    // Вариант 3: если внутри карточки есть ссылка с href, начинающимся на magnet:
    var link = cardEl.querySelector('a[href^="magnet:"]');
    if (link && link.href) return link.href;

    return null;
  }

  /**
   * Сканирует DOM и добавляет кнопки на все найденные карточки.
   * Запускается периодически, чтобы подхватывать динамически создаваемые карточки.
   */
  function scanCardsAndAddButtons() {
    var cards = document.querySelectorAll('.card'); // класс карточки в Lampa

    cards.forEach(function (card) {
      var magnet = extractMagnetFromCard(card);
      if (magnet) {
        injectQbButton(card, magnet);
      }
    });
  }

  // Запускаем сканирование сразу и потом каждые 1.5 секунды
  scanCardsAndAddButtons();
  setInterval(scanCardsAndAddButtons, 1500);

  // Экспортируем в глобальную область, если захочешь вызывать вручную
  window.LampaQbPlugin = {
    injectQbButton: injectQbButton,
    addTorrentToQb: addTorrentToQb,
    savePath: savePath
  };
})();
