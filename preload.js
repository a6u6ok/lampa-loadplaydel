(function () {
  'use strict';

  // ================= НАСТРОЙКИ =================
  var QB_URL = 'http://192.168.1.1:9080'; // роутер + порт
  var QB_USER = 'admin';                 // логин qBittorrent
  var QB_PASS = 'password';              // пароль — обязательно поменяй!
  // ============================================

  function getQbToken(cb) {
    var xhr = new XMLHttpRequest();
    xhr.open('GET', QB_URL + '/api/v2/auth/csrfToken', true);
    xhr.withCredentials = false;
    xhr.setRequestHeader('Authorization', 'Basic ' + btoa(QB_USER + ':' + QB_PASS));

    xhr.onload = function () {
      if (xhr.status === 200) {
        cb(xhr.responseText);
      } else {
        console.error('qBittorrent token error', xhr.status, xhr.responseText);
        cb(null);
      }
    };
    xhr.onerror = function () {
      cb(null);
    };
    xhr.send();
  }

  function addTorrentToQb(link, savePath, cb) {
    getQbToken(function (token) {
      if (!token) {
        cb('Не удалось получить CSRF-токен (проверь логин/пароль и доступность API)');
        return;
      }

      var formData = new FormData();
      formData.append('urls', link);
      if (savePath) {
        formData.append('save_path', savePath);
      }

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
      xhr.onerror = function () {
        cb('Ошибка сети (недоступен роутер или порт)');
      };

      xhr.send(formData);
    });
  }

  function injectQbButton(cardEl, torrentData) {
    var existing = cardEl.querySelector('[data-qb-btn]');
    if (existing) return;

    var btn = document.createElement('button');
    btn.innerText = 'qBittorrent';
    btn.className = 'button-style'; // подставь реальный класс кнопок Lampa
    btn.setAttribute('data-qb-btn', '1');

    btn.onclick = function (e) {
      e.preventDefault();
      e.stopPropagation();

      var link = torrentData.magnet || torrentData.url;
      if (!link) {
        alert('Нет ссылки на торрент');
        return;
      }

      // !!! ВСТАВЬ СЮДА РЕАЛЬНЫЙ ПУТЬ В ФС РОУТЕРА, НАЙДЕННЫЙ ЧЕРЕЗ df/ls !!!
      var savePath = '/mnt/sda1/downloads'; 

      btn.innerText = 'Отправка...';
      btn.disabled = true;

      addTorrentToQb(link, savePath, function (err) {
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

    var actionsBlock = cardEl.querySelector('.card-actions') || cardEl;
    actionsBlock.appendChild(btn);
  }

  window.LampaQbPlugin = {
    injectQbButton: injectQbButton,
    addTorrentToQb: addTorrentToQb
  };
})();
