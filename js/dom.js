/* DOM shortcuts */
(() => {
'use strict';
const Mapcast = window.Mapcast = window.Mapcast || {};

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];

Object.assign(Mapcast, { $, $$ });
})();
