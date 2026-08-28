# Signature storage

Do not commit signature image files.

Mount private PNG/JPG files into this directory at deployment time. The `employees.signature_file` column stores only the filename, for example `tsabit.png`.

The application reads signatures server-side only; they are never exposed as public static files.
