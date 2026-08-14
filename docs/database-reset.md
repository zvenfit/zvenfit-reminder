# Чистый перезапуск БД

Эта процедура предназначена только для предрелизной установки без ценных
данных. Она удаляет и старую модель (`rules`, `reminder_instances`,
`group_members`), и все таблицы текущей модели, после чего применяет единственную
начальную миграцию заново.

Обычный `npm run check`, локальный запуск и production-деплой ничего не удаляют.
Сброс запускается только вручную, требует точного пути базы и повторного ввода
`RESET`:

```bash
export YDB_ENDPOINT='grpcs://…:2135'
export YDB_DATABASE='/ru-central1/…/…'
export YDB_SERVICE_ACCOUNT_KEY_FILE_CREDENTIALS='./sa-key.json'
export CONFIRM_YDB_DATABASE="$YDB_DATABASE"
export CONFIRM_YDB_ENDPOINT="$YDB_ENDPOINT"
./scripts/reset-ydb.sh
```

Перед запуском нужно сверить `YDB_ENDPOINT` и `YDB_DATABASE` с production
secrets. После успешного сброса база содержит пустую multi-workspace схему.
Затем можно деплоить функции и Mini App, добавить бота в нужные группы и
выполнить `/setup` в каждой из них.
