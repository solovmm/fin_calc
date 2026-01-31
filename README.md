# FinCalc data pipeline

Публичные скрипты для обновления JSON с данными:
- ежедневные курсы валют к рублю
- ежемесячные макро‑данные (ставка ЦБ, инфляция, среднемесячные и «на конец месяца» курсы)
- годовая инфляция (фиксированный JSON)

## Структура
```
data/
  fx_daily.json
  inflation_ru_full_1991_2024.json
  macro_monthly.json
  last_updated.json
scripts/
  update_fx_daily.py
  update_macro_monthly.py
.github/workflows/
  daily.yml
  monthly.yml
```

## Источники
- Курсы валют: CBR XML_dynamic
- Ключевая ставка: CBR (страница KeyRate)
- Инфляция (CPI): Росстат (ipc_mes.xlsx)

Если доступ к GitHub ограничен, можно положить файл вручную:
```
data/rosstat_ipc_mes.xlsx
```
или указать путь через переменную `ROSSTAT_CPI_LOCAL`.

## Важно
- История до 2025 уже есть в `data/macro_monthly.json`.
- Скрипт **добавляет только новые месяцы (2026+)**, старые данные не трогаются.
- Годовую инфляцию обновляем вручную (не входит в скрипты).

## Валюты
Используются только эти валюты (к рублю):
- USD R01235
- EUR R01239
- CNY R01375
- GBP R01035
- CHF R01775
- THB R01675
- IDR R01280
- TRY R01700 (fallback: R01700J)
- INR R01270

## Запуск локально
```
pip install -r requirements.txt
python scripts/update_fx_daily.py
python scripts/update_macro_monthly.py
```

Пример с локальным файлом CPI:
```
ROSSTAT_CPI_LOCAL=/path/to/ipc_mes.xlsx python scripts/update_macro_monthly.py
```

## Автообновление
GitHub Actions:
- `daily.yml` — ежедневные курсы
- `monthly.yml` — проверка ежемесячных данных (запуск 15-го числа)

Если новых данных нет — коммита не будет.
