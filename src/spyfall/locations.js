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

// Themed sets (the host picks which are in play): [id, ru, en, roles...] as above.
const RUSSIA = [
  ['dacha', 'Дача', 'Dacha', [['Бабушка', 'Grandma'], ['Внук', 'Grandson'], ['Сосед по участку', 'Next-door gardener'], ['Председатель СНТ', 'Garden co-op chair'], ['Тёща', 'Mother-in-law'], ['Огородник', 'Vegetable grower']]],
  ['metro', 'Метро', 'Metro', [['Машинист', 'Train driver'], ['Дежурная у эскалатора', 'Escalator attendant'], ['Пассажир', 'Passenger'], ['Музыкант в переходе', 'Busker'], ['Полицейский', 'Police officer'], ['Турист с картой', 'Tourist with a map']]],
  ['elektrichka', 'Электричка', 'Suburban train', [['Контролёр', 'Ticket inspector'], ['Продавец всякой всячины', 'Pedlar'], ['Дачник', 'Weekend gardener'], ['Безбилетник', 'Fare dodger'], ['Студент', 'Student'], ['Рыбак', 'Fisherman']]],
  ['polyclinic', 'Поликлиника', 'Clinic', [['Терапевт', 'GP'], ['Регистратор', 'Receptionist'], ['Бабушка в очереди', 'Granny in the queue'], ['Пациент с талончиком', 'Patient with a ticket'], ['Окулист', 'Eye doctor'], ['Лаборант', 'Lab technician']]],
  ['zags', 'ЗАГС', 'Registry office', [['Регистратор', 'Registrar'], ['Невеста', 'Bride'], ['Жених', 'Groom'], ['Свидетельница', 'Maid of honour'], ['Фотограф', 'Photographer'], ['Плачущая мама', 'Tearful mother']]],
  ['market', 'Рынок', 'Market', [['Торговец фруктами', 'Fruit seller'], ['Покупатель', 'Shopper'], ['Мясник', 'Butcher'], ['Охранник', 'Guard'], ['Грузчик', 'Porter'], ['Карманник', 'Pickpocket']]],
  ['dorm', 'Общежитие', 'Student dorm', [['Комендант', 'Warden'], ['Первокурсник', 'Fresher'], ['Вахтёрша', 'Doorkeeper'], ['Староста этажа', 'Floor head'], ['Иностранный студент', 'Exchange student'], ['Кот', 'The cat']]],
  ['camp', 'Пионерлагерь', 'Summer camp', [['Вожатый', 'Counsellor'], ['Пионер', 'Camper'], ['Повар', 'Cook'], ['Физрук', 'PE teacher'], ['Медсестра', 'Nurse'], ['Начальник лагеря', 'Camp director']]],
  ['newyear', 'Новогоднее застолье', 'New Year\'s dinner', [['Хозяйка', 'Host'], ['Дед Мороз', 'Ded Moroz'], ['Снегурочка', 'Snow Maiden'], ['Гость', 'Guest'], ['Ребёнок', 'Child'], ['Сосед', 'Neighbour']]],
  ['post', 'Почта', 'Post office', [['Почтальон', 'Postman'], ['Оператор', 'Clerk'], ['Посетитель с посылкой', 'Customer with a parcel'], ['Начальник отделения', 'Branch head'], ['Курьер', 'Courier'], ['Бабушка с квитанцией', 'Granny with a bill']]],
  ['podezd', 'Подъезд', 'Apartment stairwell', [['Консьержка', 'Concierge'], ['Сосед сверху', 'Upstairs neighbour'], ['Курьер', 'Courier'], ['Сантехник', 'Plumber'], ['Кошатница', 'Cat lady'], ['Подросток', 'Teenager']]],
  ['kolkhoz', 'Колхоз', 'Collective farm', [['Председатель', 'Chairman'], ['Тракторист', 'Tractor driver'], ['Доярка', 'Milkmaid'], ['Агроном', 'Agronomist'], ['Студент на картошке', 'Student picking potatoes'], ['Сторож', 'Watchman']]],
  ['voenkomat', 'Военкомат', 'Draft office', [['Военком', 'Commissioner'], ['Призывник', 'Conscript'], ['Врач комиссии', 'Medical board doctor'], ['Мама призывника', 'Conscript\'s mum'], ['Секретарь', 'Secretary'], ['Писарь', 'Clerk']]],
  ['zhek', 'ЖЭК', 'Housing office', [['Начальник', 'Manager'], ['Сантехник', 'Plumber'], ['Электрик', 'Electrician'], ['Жилец с жалобой', 'Tenant with a complaint'], ['Бухгалтер', 'Accountant'], ['Дворник', 'Janitor']]],
  ['platskart', 'Плацкарт', 'Third-class sleeper', [['Проводница', 'Carriage attendant'], ['Пассажир с курицей', 'Passenger with a roast chicken'], ['Студент на верхней полке', 'Student on the top bunk'], ['Командировочный', 'Business traveller'], ['Семья с детьми', 'Family with kids'], ['Дембель', 'Demobbed soldier']]],
  ['skating', 'Каток', 'Ice rink', [['Тренер', 'Coach'], ['Фигуристка', 'Figure skater'], ['Новичок', 'Beginner'], ['Хоккеист', 'Hockey player'], ['Продавец чая', 'Tea seller'], ['Заливщик льда', 'Ice resurfacer']]],
  ['sanatorium', 'Санаторий', 'Health resort', [['Главврач', 'Head doctor'], ['Отдыхающий', 'Holidaymaker'], ['Массажист', 'Masseur'], ['Медсестра', 'Nurse'], ['Культорганизатор', 'Activities organiser'], ['Повар', 'Cook']]],
  ['dk', 'Дом культуры', 'House of culture', [['Директор', 'Director'], ['Хормейстер', 'Choirmaster'], ['Танцор', 'Dancer'], ['Баянист', 'Accordionist'], ['Зритель', 'Spectator'], ['Уборщица', 'Cleaner']]],
  ['fishing', 'Рыбалка на озере', 'Lake fishing trip', [['Рыбак', 'Angler'], ['Егерь', 'Game warden'], ['Новичок', 'Beginner'], ['Продавец наживки', 'Bait seller'], ['Турист', 'Camper'], ['Собака', 'The dog']]],
  ['stroyka', 'Стройка', 'Building site', [['Прораб', 'Foreman'], ['Каменщик', 'Bricklayer'], ['Крановщик', 'Crane operator'], ['Инженер', 'Engineer'], ['Сторож', 'Watchman'], ['Разнорабочий', 'Labourer']]],
];
const ADVENTURE = [
  ['royalcastle', 'Замок короля', 'Royal castle', [['Король', 'King'], ['Королева', 'Queen'], ['Шут', 'Jester'], ['Рыцарь', 'Knight'], ['Стражник', 'Guard'], ['Повар', 'Cook']]],
  ['tavern', 'Таверна', 'Tavern', [['Трактирщик', 'Innkeeper'], ['Бард', 'Bard'], ['Наёмник', 'Mercenary'], ['Путник', 'Traveller'], ['Служанка', 'Barmaid'], ['Вор', 'Thief']]],
  ['dragonlair', 'Логово дракона', 'Dragon\'s lair', [['Дракон', 'Dragon'], ['Рыцарь', 'Knight'], ['Принцесса', 'Princess'], ['Оруженосец', 'Squire'], ['Кладоискатель', 'Treasure hunter'], ['Маг', 'Wizard']]],
  ['treasureisland', 'Остров сокровищ', 'Treasure island', [['Капитан', 'Captain'], ['Картограф', 'Mapmaker'], ['Пленник', 'Castaway'], ['Попугай', 'Parrot'], ['Местный житель', 'Islander'], ['Юнга', 'Cabin boy']]],
  ['saloon', 'Салун на Диком Западе', 'Wild West saloon', [['Шериф', 'Sheriff'], ['Бандит', 'Outlaw'], ['Бармен', 'Bartender'], ['Ковбой', 'Cowboy'], ['Картёжник', 'Card sharp'], ['Певица', 'Singer']]],
  ['pyramid', 'Египетская пирамида', 'Egyptian pyramid', [['Фараон', 'Pharaoh'], ['Жрец', 'Priest'], ['Археолог', 'Archaeologist'], ['Расхитительница гробниц', 'Tomb raider'], ['Носильщик', 'Porter'], ['Мумия', 'Mummy']]],
  ['tournament', 'Рыцарский турнир', 'Jousting tournament', [['Рыцарь', 'Knight'], ['Герольд', 'Herald'], ['Судья', 'Judge'], ['Оруженосец', 'Squire'], ['Зритель', 'Spectator'], ['Прекрасная дама', 'Fair lady']]],
  ['vikings', 'Корабль викингов', 'Viking ship', [['Конунг', 'Chieftain'], ['Гребец', 'Rower'], ['Скальд', 'Skald'], ['Берсерк', 'Berserker'], ['Пленник', 'Captive'], ['Кормчий', 'Helmsman']]],
  ['magicschool', 'Школа магии', 'School of magic', [['Директор', 'Headmaster'], ['Ученик', 'Student'], ['Учитель зельеварения', 'Potions teacher'], ['Привидение', 'Ghost'], ['Библиотекарь', 'Librarian'], ['Сова', 'Owl']]],
  ['colosseum', 'Колизей', 'Colosseum', [['Гладиатор', 'Gladiator'], ['Император', 'Emperor'], ['Зритель', 'Spectator'], ['Лев', 'Lion'], ['Ланиста', 'Gladiator trainer'], ['Продавец вина', 'Wine seller']]],
  ['monastery', 'Монастырь', 'Monastery', [['Настоятель', 'Abbot'], ['Монах', 'Monk'], ['Послушник', 'Novice'], ['Паломник', 'Pilgrim'], ['Летописец', 'Chronicler'], ['Пасечник', 'Beekeeper']]],
  ['jungle', 'Экспедиция в джунглях', 'Jungle expedition', [['Проводник', 'Guide'], ['Учёный', 'Scientist'], ['Фотограф', 'Photographer'], ['Повар', 'Cook'], ['Носильщик', 'Porter'], ['Шаман', 'Shaman']]],
  ['haunted', 'Замок с привидениями', 'Haunted castle', [['Привидение', 'Ghost'], ['Дворецкий', 'Butler'], ['Наследник', 'Heir'], ['Медиум', 'Medium'], ['Экскурсант', 'Tourist'], ['Детектив', 'Detective']]],
  ['ufo', 'Корабль пришельцев', 'Alien spaceship', [['Капитан пришельцев', 'Alien captain'], ['Похищенный землянин', 'Abducted human'], ['Учёный-пришелец', 'Alien scientist'], ['Пилот', 'Pilot'], ['Робот', 'Robot'], ['Переводчик', 'Translator']]],
  ['cave', 'Пещера первобытных людей', 'Caveman cave', [['Вождь', 'Chief'], ['Охотник', 'Hunter'], ['Шаман', 'Shaman'], ['Художник на стенах', 'Cave painter'], ['Собиратель', 'Gatherer'], ['Ребёнок', 'Child']]],
];
const CITY = [
  ['cinema', 'Кинотеатр', 'Cinema', [['Киномеханик', 'Projectionist'], ['Кассир', 'Cashier'], ['Зритель', 'Moviegoer'], ['Продавец попкорна', 'Popcorn seller'], ['Пара на последнем ряду', 'Couple in the back row'], ['Билетёр', 'Usher']]],
  ['gym', 'Спортзал', 'Gym', [['Тренер', 'Trainer'], ['Качок', 'Bodybuilder'], ['Новичок', 'Beginner'], ['Администратор', 'Receptionist'], ['Йогиня', 'Yoga fan'], ['Уборщик', 'Cleaner']]],
  ['nightclub', 'Ночной клуб', 'Nightclub', [['Диджей', 'DJ'], ['Охранник', 'Bouncer'], ['Бармен', 'Bartender'], ['Тусовщик', 'Party animal'], ['Промоутер', 'Promoter'], ['Танцовщица', 'Dancer']]],
  ['barbershop', 'Барбершоп', 'Barbershop', [['Барбер', 'Barber'], ['Клиент', 'Client'], ['Администратор', 'Receptionist'], ['Стажёр', 'Trainee'], ['Ожидающий очереди', 'Waiting client'], ['Владелец', 'Owner']]],
  ['library', 'Библиотека', 'Library', [['Библиотекарь', 'Librarian'], ['Читатель', 'Reader'], ['Студент', 'Student'], ['Писатель', 'Writer'], ['Уборщица', 'Cleaner'], ['Школьник', 'Schoolkid']]],
  ['bakery', 'Пекарня', 'Bakery', [['Пекарь', 'Baker'], ['Кассир', 'Cashier'], ['Покупатель', 'Customer'], ['Кондитер', 'Pastry chef'], ['Курьер', 'Courier'], ['Владелец', 'Owner']]],
  ['pharmacy', 'Аптека', 'Pharmacy', [['Фармацевт', 'Pharmacist'], ['Покупатель', 'Customer'], ['Курьер', 'Courier'], ['Заведующая', 'Manager'], ['Стажёр', 'Trainee'], ['Охранник', 'Guard']]],
  ['coworking', 'Коворкинг', 'Coworking space', [['Фрилансер', 'Freelancer'], ['Стартапер', 'Startup founder'], ['Администратор', 'Community manager'], ['Программист', 'Programmer'], ['Дизайнер', 'Designer'], ['Бариста', 'Barista']]],
  ['karaoke', 'Караоке-бар', 'Karaoke bar', [['Ведущий', 'MC'], ['Певец', 'Singer'], ['Бармен', 'Bartender'], ['Официант', 'Waiter'], ['Стеснительный гость', 'Shy guest'], ['Именинник', 'Birthday person']]],
  ['playground', 'Детская площадка', 'Playground', [['Мама', 'Mum'], ['Папа', 'Dad'], ['Ребёнок', 'Child'], ['Бабушка', 'Grandma'], ['Няня', 'Nanny'], ['Собачник', 'Dog walker']]],
  ['bus', 'Автобус', 'City bus', [['Водитель', 'Driver'], ['Кондуктор', 'Conductor'], ['Пассажир', 'Passenger'], ['Контролёр', 'Ticket inspector'], ['Школьник', 'Schoolkid'], ['Пенсионер', 'Pensioner']]],
  ['mall', 'Торговый центр', 'Shopping mall', [['Продавец', 'Shop assistant'], ['Покупатель', 'Shopper'], ['Охранник', 'Guard'], ['Аниматор', 'Entertainer'], ['Уборщик', 'Cleaner'], ['Промоутер', 'Promoter']]],
  ['vet', 'Ветклиника', 'Vet clinic', [['Ветеринар', 'Vet'], ['Хозяин кота', 'Cat owner'], ['Хозяйка собаки', 'Dog owner'], ['Ассистент', 'Assistant'], ['Администратор', 'Receptionist'], ['Попугай', 'Parrot']]],
  ['laundry', 'Прачечная', 'Laundromat', [['Работник', 'Attendant'], ['Клиент', 'Customer'], ['Владелец', 'Owner'], ['Курьер', 'Courier'], ['Студент', 'Student'], ['Сосед', 'Neighbour']]],
  ['itoffice', 'Офис IT-компании', 'Tech company office', [['Тимлид', 'Team lead'], ['Программист', 'Programmer'], ['Тестировщик', 'Tester'], ['Эйчар', 'HR'], ['Директор', 'CEO'], ['Стажёр', 'Intern']]],
];
const TRAVEL = [
  ['airport', 'Аэропорт', 'Airport', [['Пограничник', 'Border officer'], ['Пассажир', 'Passenger'], ['Носильщик', 'Porter'], ['Сотрудник досмотра', 'Security screener'], ['Стюардесса', 'Flight attendant'], ['Таксист', 'Taxi driver']]],
  ['campsite', 'Палаточный лагерь', 'Campsite', [['Турист', 'Hiker'], ['Инструктор', 'Instructor'], ['Гитарист', 'Guitar player'], ['Повар', 'Cook'], ['Новичок', 'First-timer'], ['Лесник', 'Forester']]],
  ['skiresort', 'Горнолыжный курорт', 'Ski resort', [['Инструктор', 'Instructor'], ['Лыжник', 'Skier'], ['Сноубордист', 'Snowboarder'], ['Спасатель', 'Ski patrol'], ['Работник подъёмника', 'Lift operator'], ['Повар', 'Cook']]],
  ['allinclusive', 'Отель «всё включено»', 'All-inclusive resort', [['Аниматор', 'Entertainer'], ['Турист', 'Tourist'], ['Бармен', 'Bartender'], ['Горничная', 'Housekeeper'], ['Гид', 'Guide'], ['Спасатель у бассейна', 'Pool lifeguard']]],
  ['safari', 'Сафари', 'Safari', [['Гид', 'Guide'], ['Турист', 'Tourist'], ['Фотограф', 'Photographer'], ['Водитель джипа', 'Jeep driver'], ['Ветеринар', 'Vet'], ['Лев', 'Lion']]],
  ['climb', 'Восхождение на гору', 'Mountain climb', [['Альпинист', 'Climber'], ['Шерп', 'Sherpa'], ['Врач', 'Doctor'], ['Фотограф', 'Photographer'], ['Руководитель экспедиции', 'Expedition leader'], ['Новичок', 'Novice']]],
  ['tourbus', 'Экскурсионный автобус', 'Tour bus', [['Гид', 'Guide'], ['Водитель', 'Driver'], ['Турист', 'Tourist'], ['Фотограф', 'Photographer'], ['Опоздавший', 'Latecomer'], ['Пенсионерка', 'Pensioner']]],
  ['gasstation', 'Заправка на трассе', 'Highway gas station', [['Заправщик', 'Attendant'], ['Кассир', 'Cashier'], ['Дальнобойщик', 'Trucker'], ['Турист', 'Road tripper'], ['Полицейский', 'Police officer'], ['Автостопщик', 'Hitchhiker']]],
  ['hostel', 'Хостел', 'Hostel', [['Администратор', 'Receptionist'], ['Путешественник', 'Backpacker'], ['Уборщик', 'Cleaner'], ['Студент', 'Student'], ['Повар', 'Cook'], ['Храпящий сосед', 'Snoring roommate']]],
  ['festival', 'Музыкальный фестиваль', 'Music festival', [['Музыкант', 'Musician'], ['Зритель', 'Fan'], ['Продавец', 'Vendor'], ['Организатор', 'Organiser'], ['Охранник', 'Security'], ['Волонтёр', 'Volunteer']]],
  ['station', 'Вокзал', 'Railway station', [['Кассир', 'Ticket seller'], ['Пассажир', 'Passenger'], ['Носильщик', 'Porter'], ['Полицейский', 'Police officer'], ['Буфетчица', 'Snack bar lady'], ['Встречающий', 'Person meeting a train']]],
  ['riverboat', 'Речной теплоход', 'River cruise', [['Капитан', 'Captain'], ['Матрос', 'Deckhand'], ['Турист', 'Tourist'], ['Экскурсовод', 'Guide'], ['Музыкант', 'Musician'], ['Повар', 'Cook']]],
  ['aquapark', 'Аквапарк', 'Water park', [['Спасатель', 'Lifeguard'], ['Посетитель', 'Visitor'], ['Ребёнок', 'Child'], ['Кассир', 'Cashier'], ['Аниматор', 'Entertainer'], ['Продавец мороженого', 'Ice cream seller']]],
  ['amusement', 'Парк аттракционов', 'Amusement park', [['Оператор аттракциона', 'Ride operator'], ['Посетитель', 'Visitor'], ['Продавец сладкой ваты', 'Candy floss seller'], ['Охранник', 'Guard'], ['Ребёнок', 'Child'], ['Клоун', 'Clown']]],
  ['lighthouse', 'Маяк', 'Lighthouse', [['Смотритель', 'Keeper'], ['Турист', 'Tourist'], ['Рыбак', 'Fisherman'], ['Фотограф', 'Photographer'], ['Капитан', 'Captain'], ['Моряк', 'Sailor']]],
];

// The sets the host can pick from, in this order in the lobby.
const PACKS = { classic: RAW, russia: RUSSIA, adventure: ADVENTURE, city: CITY, travel: TRAVEL };
const LOCATIONS = Object.entries(PACKS).flatMap(([pack, list]) =>
  list.map(([id, ru, en, roles]) => ({ id, pack, ru, en, roles: roles.map(([r, e]) => ({ ru: r, en: e })) })));
const byId = Object.fromEntries(LOCATIONS.map(l => [l.id, l]));
const PACK_IDS = Object.keys(PACKS);

module.exports = { LOCATIONS, byId, PACK_IDS };
