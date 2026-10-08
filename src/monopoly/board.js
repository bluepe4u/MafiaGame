'use strict';

// The Monopoly board: official order, prices and rents, with the street names of the classic
// Russian edition (Moscow streets). Amounts are in ₽ at the official values.
//
// rent: [base, 1 house, 2, 3, 4, hotel]; mortgage is half the price; unmortgaging costs +10%.

const street = (name, en, group, price, rent, house) => ({ type: 'street', name, en, group, price, rent, house });
const railway = (name, en) => ({ type: 'railway', name, en, price: 200 });
const utility = (name, en) => ({ type: 'utility', name, en, price: 150 });

const SQUARES = [
  { type: 'go', name: 'Вперёд', en: 'GO' },
  street('Житная улица', 'Zhitnaya St', 'brown', 60, [2, 10, 30, 90, 160, 250], 50),
  { type: 'chest', name: 'Общественная казна', en: 'Community Chest' },
  street('Нагатинская улица', 'Nagatinskaya St', 'brown', 60, [4, 20, 60, 180, 320, 450], 50),
  { type: 'tax', name: 'Подоходный налог', en: 'Income Tax', amount: 200 },
  railway('Рижская железная дорога', 'Riga Railway'),
  street('Варшавское шоссе', 'Varshavskoye Hwy', 'lightblue', 100, [6, 30, 90, 270, 400, 550], 50),
  { type: 'chance', name: 'Шанс', en: 'Chance' },
  street('Улица Огарёва', 'Ogaryova St', 'lightblue', 100, [6, 30, 90, 270, 400, 550], 50),
  street('1-я Парковая улица', '1st Parkovaya St', 'lightblue', 120, [8, 40, 100, 300, 450, 600], 50),
  { type: 'jail', name: 'Тюрьма', en: 'Jail' },
  street('Улица Полянка', 'Polyanka St', 'pink', 140, [10, 50, 150, 450, 625, 750], 100),
  utility('Электростанция', 'Electric Company'),
  street('Улица Сретенка', 'Sretenka St', 'pink', 140, [10, 50, 150, 450, 625, 750], 100),
  street('Ростовская набережная', 'Rostovskaya Emb', 'pink', 160, [12, 60, 180, 500, 700, 900], 100),
  railway('Курская железная дорога', 'Kursk Railway'),
  street('Рязанский проспект', 'Ryazansky Ave', 'orange', 180, [14, 70, 200, 550, 750, 950], 100),
  { type: 'chest', name: 'Общественная казна', en: 'Community Chest' },
  street('Улица Вавилова', 'Vavilova St', 'orange', 180, [14, 70, 200, 550, 750, 950], 100),
  street('Рублёвское шоссе', 'Rublyovskoye Hwy', 'orange', 200, [16, 80, 220, 600, 800, 1000], 100),
  { type: 'parking', name: 'Бесплатная стоянка', en: 'Free Parking' },
  street('Улица Тверская', 'Tverskaya St', 'red', 220, [18, 90, 250, 700, 875, 1050], 150),
  { type: 'chance', name: 'Шанс', en: 'Chance' },
  street('Пушкинская улица', 'Pushkinskaya St', 'red', 220, [18, 90, 250, 700, 875, 1050], 150),
  street('Площадь Маяковского', 'Mayakovsky Sq', 'red', 240, [20, 100, 300, 750, 925, 1100], 150),
  railway('Казанская железная дорога', 'Kazan Railway'),
  street('Улица Грузинский Вал', 'Gruzinsky Val St', 'yellow', 260, [22, 110, 330, 800, 975, 1150], 150),
  street('Новинский бульвар', 'Novinsky Blvd', 'yellow', 260, [22, 110, 330, 800, 975, 1150], 150),
  utility('Водопровод', 'Water Works'),
  street('Смоленская площадь', 'Smolenskaya Sq', 'yellow', 280, [24, 120, 360, 850, 1025, 1200], 150),
  { type: 'gotojail', name: 'Отправляйтесь в тюрьму', en: 'Go to Jail' },
  street('Улица Щусева', 'Shchuseva St', 'green', 300, [26, 130, 390, 900, 1100, 1275], 200),
  street('Гоголевский бульвар', 'Gogolevsky Blvd', 'green', 300, [26, 130, 390, 900, 1100, 1275], 200),
  { type: 'chest', name: 'Общественная казна', en: 'Community Chest' },
  street('Кутузовский проспект', 'Kutuzovsky Ave', 'green', 320, [28, 150, 450, 1000, 1200, 1400], 200),
  railway('Ленинградская железная дорога', 'Leningrad Railway'),
  { type: 'chance', name: 'Шанс', en: 'Chance' },
  street('Улица Малая Бронная', 'Malaya Bronnaya St', 'darkblue', 350, [35, 175, 500, 1100, 1300, 1500], 200),
  { type: 'tax', name: 'Сверхналог', en: 'Luxury Tax', amount: 100 },
  street('Улица Арбат', 'Arbat St', 'darkblue', 400, [50, 200, 600, 1400, 1700, 2000], 200),
];

const JAIL = 10;
const GO_TO_JAIL = 30;
const RAILWAY_RENT = [25, 50, 100, 200];
const GROUPS = {};
SQUARES.forEach((sq, i) => { if (sq.group) (GROUPS[sq.group] ||= []).push(i); });
const isProperty = i => ['street', 'railway', 'utility'].includes(SQUARES[i].type);

// Card texts are translation keys (mono.card.<id>) on the client. Moves name square indexes.
const CHANCE = [
  { id: 'c.arbat', advance: 39 },
  { id: 'c.go', advance: 0 },
  { id: 'c.mayakovsky', advance: 24 },
  { id: 'c.polyanka', advance: 11 },
  { id: 'c.railway1', nearest: 'railway' },
  { id: 'c.railway2', nearest: 'railway' },
  { id: 'c.utility', nearest: 'utility' },
  { id: 'c.dividend', money: 50 },
  { id: 'c.jailfree', jailFree: true },
  { id: 'c.back3', back: 3 },
  { id: 'c.jail', jail: true },
  { id: 'c.repairs', repairs: [25, 100] },
  { id: 'c.speeding', money: -15 },
  { id: 'c.riga', advance: 5 },
  { id: 'c.chairman', eachPlayer: -50 },
  { id: 'c.loan', money: 150 },
];

const CHEST = [
  { id: 'k.go', advance: 0 },
  { id: 'k.bankerror', money: 200 },
  { id: 'k.doctor', money: -50 },
  { id: 'k.stock', money: 50 },
  { id: 'k.jailfree', jailFree: true },
  { id: 'k.jail', jail: true },
  { id: 'k.holiday', money: 100 },
  { id: 'k.taxrefund', money: 20 },
  { id: 'k.birthday', eachPlayer: 10 },
  { id: 'k.insurance', money: 100 },
  { id: 'k.hospital', money: -100 },
  { id: 'k.school', money: -50 },
  { id: 'k.consultancy', money: 25 },
  { id: 'k.streetrepairs', repairs: [40, 115] },
  { id: 'k.beauty', money: 10 },
  { id: 'k.inherit', money: 100 },
];


// Short names for drawing on the board (full names are on the title-deed cards).
const SHORT = {
  'Общественная казна': ['Казна', 'Chest'],
  'Житная улица': ['Житная', 'Zhitnaya'],
  'Нагатинская улица': ['Нагатинская', 'Nagatinskaya'],
  'Подоходный налог': ['Подоходный налог', 'Income Tax'],
  'Рижская железная дорога': ['Рижская ж/д', 'Riga Rly'],
  'Варшавское шоссе': ['Варшавское ш.', 'Varshavskoye'],
  'Улица Огарёва': ['Огарёва', 'Ogaryova'],
  '1-я Парковая улица': ['1-я Парковая', '1st Parkovaya'],
  'Улица Полянка': ['Полянка', 'Polyanka'],
  'Электростанция': ['Электро­станция', 'Electric Co'],
  'Улица Сретенка': ['Сретенка', 'Sretenka'],
  'Ростовская набережная': ['Ростовская наб.', 'Rostovskaya Emb'],
  'Курская железная дорога': ['Курская ж/д', 'Kursk Rly'],
  'Рязанский проспект': ['Рязанский пр.', 'Ryazansky Ave'],
  'Улица Вавилова': ['Вавилова', 'Vavilova'],
  'Рублёвское шоссе': ['Рублёвское ш.', 'Rublyovka'],
  'Улица Тверская': ['Тверская', 'Tverskaya'],
  'Пушкинская улица': ['Пушкинская', 'Pushkinskaya'],
  'Площадь Маяковского': ['Пл. Маяковского', 'Mayakovsky Sq'],
  'Казанская железная дорога': ['Казанская ж/д', 'Kazan Rly'],
  'Улица Грузинский Вал': ['Грузинский Вал', 'Gruzinsky Val'],
  'Новинский бульвар': ['Новинский б-р', 'Novinsky Blvd'],
  'Водопровод': ['Водопровод', 'Water Works'],
  'Смоленская площадь': ['Смоленская пл.', 'Smolenskaya Sq'],
  'Улица Щусева': ['Щусева', 'Shchuseva'],
  'Гоголевский бульвар': ['Гоголевский б-р', 'Gogolevsky Blvd'],
  'Кутузовский проспект': ['Кутузовский пр.', 'Kutuzovsky Ave'],
  'Ленинградская железная дорога': ['Ленинградская ж/д', 'Leningrad Rly'],
  'Улица Малая Бронная': ['Малая Бронная', 'Malaya Bronnaya'],
  'Сверхналог': ['Сверхналог', 'Luxury Tax'],
  'Улица Арбат': ['Арбат', 'Arbat'],
};
SQUARES.forEach(sq => { const sh = SHORT[sq.name]; sq.short = sh ? sh[0] : sq.name; sq.shortEn = sh ? sh[1] : sq.en; });

module.exports = { SQUARES, JAIL, GO_TO_JAIL, RAILWAY_RENT, GROUPS, CHANCE, CHEST, isProperty };
