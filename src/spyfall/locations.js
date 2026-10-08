'use strict';

// Locations for "Find the spy": every non-spy gets the same location and one of its roles.
// Our own list; each entry is [id, ru, en, [[ru, en] roles...]].
const RAW = [
  ['plane', 'Самолёт', 'Airplane', [['Пилот', 'Pilot'], ['Стюардесса', 'Flight attendant'], ['Пассажир бизнес-класса', 'Business class passenger'], ['Пассажир эконома', 'Economy passenger'], ['Механик', 'Mechanic'], ['Безбилетник', 'Stowaway']]],
  ['bank', 'Банк', 'Bank', [['Кассир', 'Teller'], ['Охранник', 'Guard'], ['Управляющий', 'Manager'], ['Клиент', 'Customer'], ['Грабитель', 'Robber'], ['Инкассатор', 'Cash courier']]],
  ['beach', 'Пляж', 'Beach', [['Спасатель', 'Lifeguard'], ['Отдыхающий', 'Sunbather'], ['Продавец кукурузы', 'Corn seller'], ['Сёрфер', 'Surfer'], ['Фотограф', 'Photographer'], ['Ребёнок', 'Kid']]],
  ['theater', 'Театр', 'Theater', [['Актёр', 'Actor'], ['Режиссёр', 'Director'], ['Суфлёр', 'Prompter'], ['Гардеробщица', 'Cloakroom attendant'], ['Зритель', 'Spectator'], ['Критик', 'Critic']]],
  ['casino', 'Казино', 'Casino', [['Крупье', 'Croupier'], ['Игрок', 'Gambler'], ['Охранник', 'Bouncer'], ['Бармен', 'Bartender'], ['Владелец', 'Owner'], ['Шулер', 'Cheater']]],
  ['circus', 'Цирк', 'Circus', [['Клоун', 'Clown'], ['Акробат', 'Acrobat'], ['Дрессировщик', 'Animal trainer'], ['Фокусник', 'Magician'], ['Зритель', 'Spectator'], ['Шпагоглотатель', 'Sword swallower']]],
  ['hospital', 'Больница', 'Hospital', [['Хирург', 'Surgeon'], ['Медсестра', 'Nurse'], ['Пациент', 'Patient'], ['Главврач', 'Chief doctor'], ['Санитар', 'Orderly'], ['Посетитель', 'Visitor']]],
  ['hotel', 'Отель', 'Hotel', [['Портье', 'Receptionist'], ['Горничная', 'Housekeeper'], ['Постоялец', 'Guest'], ['Швейцар', 'Doorman'], ['Повар', 'Chef'], ['Управляющий', 'Manager']]],
  ['base', 'Военная база', 'Military base', [['Генерал', 'General'], ['Рядовой', 'Private'], ['Часовой', 'Sentry'], ['Повар', 'Cook'], ['Медик', 'Medic'], ['Новобранец', 'Recruit']]],
  ['studio', 'Киностудия', 'Film studio', [['Режиссёр', 'Director'], ['Каскадёр', 'Stuntman'], ['Звезда', 'Movie star'], ['Оператор', 'Camera operator'], ['Гримёр', 'Makeup artist'], ['Массовка', 'Extra']]],
  ['train', 'Поезд дальнего следования', 'Long-distance train', [['Проводник', 'Conductor'], ['Машинист', 'Train driver'], ['Пассажир', 'Passenger'], ['Продавец в вагоне-ресторане', 'Dining car waiter'], ['Контролёр', 'Ticket inspector'], ['Студент', 'Student']]],
  ['pirates', 'Пиратский корабль', 'Pirate ship', [['Капитан', 'Captain'], ['Кок', 'Cook'], ['Юнга', 'Cabin boy'], ['Пленник', 'Prisoner'], ['Канонир', 'Gunner'], ['Попугай', 'Parrot']]],
  ['polar', 'Полярная станция', 'Polar station', [['Начальник станции', 'Station chief'], ['Метеоролог', 'Meteorologist'], ['Биолог', 'Biologist'], ['Радист', 'Radio operator'], ['Повар', 'Cook'], ['Геолог', 'Geologist']]],
  ['police', 'Полицейский участок', 'Police station', [['Детектив', 'Detective'], ['Дежурный', 'Desk officer'], ['Задержанный', 'Suspect'], ['Адвокат', 'Lawyer'], ['Журналист', 'Journalist'], ['Криминалист', 'Forensic expert']]],
  ['restaurant', 'Ресторан', 'Restaurant', [['Шеф-повар', 'Head chef'], ['Официант', 'Waiter'], ['Посетитель', 'Diner'], ['Сомелье', 'Sommelier'], ['Музыкант', 'Musician'], ['Ресторанный критик', 'Food critic']]],
  ['school', 'Школа', 'School', [['Учитель', 'Teacher'], ['Директор', 'Principal'], ['Ученик', 'Student'], ['Завхоз', 'Caretaker'], ['Родитель', 'Parent'], ['Повариха в столовой', 'Lunch lady']]],
  ['carservice', 'Автосервис', 'Car repair shop', [['Механик', 'Mechanic'], ['Мойщик', 'Car washer'], ['Клиент', 'Customer'], ['Менеджер', 'Manager'], ['Шиномонтажник', 'Tire fitter'], ['Электрик', 'Electrician']]],
  ['space', 'Космическая станция', 'Space station', [['Командир', 'Commander'], ['Инженер', 'Engineer'], ['Учёный', 'Scientist'], ['Космический турист', 'Space tourist'], ['Врач', 'Doctor'], ['Пришелец', 'Alien']]],
  ['submarine', 'Подводная лодка', 'Submarine', [['Капитан', 'Captain'], ['Акустик', 'Sonar operator'], ['Матрос', 'Sailor'], ['Кок', 'Cook'], ['Механик', 'Engineer'], ['Штурман', 'Navigator']]],
  ['supermarket', 'Супермаркет', 'Supermarket', [['Кассир', 'Cashier'], ['Покупатель', 'Shopper'], ['Охранник', 'Security guard'], ['Грузчик', 'Stock clerk'], ['Мерчендайзер', 'Merchandiser'], ['Продавец в отделе мяса', 'Butcher']]],
  ['university', 'Университет', 'University', [['Профессор', 'Professor'], ['Студент', 'Student'], ['Аспирант', 'PhD student'], ['Ректор', 'Rector'], ['Вахтёр', 'Porter'], ['Библиотекарь', 'Librarian']]],
  ['liner', 'Круизный лайнер', 'Cruise ship', [['Капитан', 'Captain'], ['Богатый турист', 'Rich tourist'], ['Аниматор', 'Entertainer'], ['Бармен', 'Bartender'], ['Матрос', 'Sailor'], ['Музыкант', 'Musician']]],
  ['party', 'Корпоратив', 'Office party', [['Начальник', 'Boss'], ['Бухгалтер', 'Accountant'], ['Новичок', 'New hire'], ['Ведущий', 'Host'], ['Курьер', 'Courier'], ['Секретарь', 'Secretary']]],
  ['spa', 'Спа-салон', 'Spa', [['Массажист', 'Masseur'], ['Косметолог', 'Beautician'], ['Клиент', 'Client'], ['Администратор', 'Receptionist'], ['Маникюрщица', 'Manicurist'], ['Йог', 'Yoga instructor']]],
  ['embassy', 'Посольство', 'Embassy', [['Посол', 'Ambassador'], ['Охранник', 'Guard'], ['Переводчик', 'Interpreter'], ['Секретарь', 'Secretary'], ['Турист без визы', 'Tourist without a visa'], ['Дипломат', 'Diplomat']]],
  ['zoo', 'Зоопарк', 'Zoo', [['Смотритель', 'Zookeeper'], ['Ветеринар', 'Vet'], ['Посетитель', 'Visitor'], ['Продавец мороженого', 'Ice cream seller'], ['Фотограф', 'Photographer'], ['Экскурсовод', 'Guide']]],
  ['museum', 'Музей', 'Museum', [['Экскурсовод', 'Guide'], ['Смотрительница', 'Gallery attendant'], ['Реставратор', 'Restorer'], ['Турист', 'Tourist'], ['Вор картин', 'Art thief'], ['Директор музея', 'Museum director']]],
  ['stadium', 'Стадион', 'Stadium', [['Футболист', 'Football player'], ['Тренер', 'Coach'], ['Судья', 'Referee'], ['Болельщик', 'Fan'], ['Комментатор', 'Commentator'], ['Продавец хот-догов', 'Hot dog seller']]],
  ['banya', 'Баня', 'Bathhouse', [['Банщик', 'Bath attendant'], ['Завсегдатай', 'Regular'], ['Новичок', 'First-timer'], ['Массажист', 'Masseur'], ['Продавец веников', 'Broom seller'], ['Администратор', 'Receptionist']]],
  ['wedding', 'Свадьба', 'Wedding', [['Невеста', 'Bride'], ['Жених', 'Groom'], ['Тамада', 'Toastmaster'], ['Свидетель', 'Best man'], ['Фотограф', 'Photographer'], ['Тёща', 'Mother-in-law']]],
];

const LOCATIONS = RAW.map(([id, ru, en, roles]) => ({ id, ru, en, roles: roles.map(([r, e]) => ({ ru: r, en: e })) }));
const byId = Object.fromEntries(LOCATIONS.map(l => [l.id, l]));

module.exports = { LOCATIONS, byId };
