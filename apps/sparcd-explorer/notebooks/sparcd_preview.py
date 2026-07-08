import marimo

__generated_with = "0.23.8"
app = marimo.App(width="medium")


@app.cell
def _():
    import marimo as mo

    return (mo,)


@app.cell
def _(mo):
    mo.md("""
    # SPARC'd preview

    Connects to the SPARC'd MinIO/S3 backend (image collections, uploads)
    and — if configured — a local copy of the SQLite app-state DB.

    Credentials are read from `.env` (copy `.env.example`). You can also
    override them per-session in the form below.
    """)
    return


@app.cell
def _():
    import os
    from pathlib import Path
    from urllib.parse import urlparse

    from dotenv import load_dotenv

    env_path = Path(__file__).resolve().parent.parent / ".env"
    load_dotenv(env_path)

    def normalize_endpoint(raw: str, default_secure: bool) -> tuple[str, bool]:
        raw = (raw or "").strip()
        if "://" in raw:
            p = urlparse(raw)
            return p.netloc, p.scheme == "https"
        return raw, default_secure

    default_secure = os.getenv("SPARCD_S3_SECURE", "true").lower() == "true"
    ep, env_secure = normalize_endpoint(os.getenv("SPARCD_S3_ENDPOINT", ""), default_secure)

    env = {
        "endpoint": ep,
        "access_key": os.getenv("SPARCD_S3_ACCESS_KEY", ""),
        "secret_key": os.getenv("SPARCD_S3_SECRET_KEY", ""),
        "secure": env_secure,
        "bucket": os.getenv("SPARCD_S3_BUCKET", ""),
        "db_path": os.getenv("SPARCD_DB", ""),
    }
    return env, normalize_endpoint


@app.cell
def _(env, mo):
    endpoint = mo.ui.text(
        label="S3 endpoint (host[:port], no scheme)",
        value=env["endpoint"],
        full_width=True,
    )
    access_key = mo.ui.text(label="Access key", value=env["access_key"], full_width=True)
    secret_key = mo.ui.text(
        label="Secret key",
        value=env["secret_key"],
        kind="password",
        full_width=True,
    )
    secure = mo.ui.checkbox(label="Use HTTPS (secure)", value=env["secure"])
    bucket = mo.ui.text(
        label="Bucket (optional — leave blank to list all)",
        value=env["bucket"],
        full_width=True,
    )
    db_path = mo.ui.text(
        label="SQLite path (optional)",
        value=env["db_path"],
        full_width=True,
    )

    form = mo.vstack([endpoint, access_key, secret_key, secure, bucket, db_path])
    form
    return access_key, bucket, db_path, endpoint, secret_key, secure


@app.cell
def _(access_key, endpoint, mo, normalize_endpoint, secret_key, secure):
    from minio import Minio

    client = None
    status = "Fill in endpoint + access key + secret key above."
    if endpoint.value and access_key.value and secret_key.value:
        ep_host, ep_secure = normalize_endpoint(endpoint.value, secure.value)
        client = Minio(
            ep_host,
            access_key=access_key.value,
            secret_key=secret_key.value,
            secure=ep_secure,
        )
        status = f"Connected client built for `{ep_host}` (secure={ep_secure})."

    mo.md(status)
    return (client,)


@app.cell
def _(client, mo):
    import polars as pl

    buckets_df = pl.DataFrame()
    if client is not None:
        bucket_rows = [
            {"name": b.name, "creation_date": b.creation_date}
            for b in client.list_buckets()
        ]
        buckets_df = pl.DataFrame(bucket_rows) if bucket_rows else pl.DataFrame()

    mo.md("## Buckets")
    return buckets_df, pl


@app.cell
def _(buckets_df):
    buckets_df
    return


@app.cell
def _(bucket, buckets_df, mo):
    target_bucket = bucket.value.strip() or (
        buckets_df["name"][0] if buckets_df.height > 0 else ""
    )
    mo.md(
        f"## Objects in `{target_bucket}`"
        if target_bucket
        else "_No bucket selected._"
    )
    return (target_bucket,)


@app.cell
def _(client, pl, target_bucket):
    objects_df = pl.DataFrame()
    if client is not None and target_bucket:
        objects = []
        for obj in client.list_objects(target_bucket, recursive=True):
            objects.append(
                {
                    "object": obj.object_name,
                    "size": obj.size,
                    "last_modified": obj.last_modified,
                    "is_dir": obj.is_dir,
                }
            )
            if len(objects) >= 200:
                break
        objects_df = pl.DataFrame(objects) if objects else pl.DataFrame()

    objects_df
    return


@app.cell
def _(mo):
    mo.md("""
    ## SQLite tables
    """)
    return


@app.cell
def _(db_path, pl):
    import sqlite3
    from pathlib import Path as SQLitePath

    tables_df = pl.DataFrame()
    conn = None
    if db_path.value and SQLitePath(db_path.value).exists():
        conn = sqlite3.connect(db_path.value)
        tables_cur = conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
        )
        table_names = [r[0] for r in tables_cur.fetchall()]
        table_rows = []
        for name in table_names:
            count = conn.execute(f'SELECT COUNT(*) FROM "{name}"').fetchone()[0]
            table_rows.append({"table": name, "rows": count})
        tables_df = pl.DataFrame(table_rows) if table_rows else pl.DataFrame()

    tables_df
    return (conn,)


@app.cell
def _(conn, mo, pl):
    preview_df = pl.DataFrame()
    if conn is not None:
        preview_cur = conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name LIMIT 1"
        )
        row = preview_cur.fetchone()
        if row is not None:
            first = row[0]
            preview_df = pl.read_database(
                query=f'SELECT * FROM "{first}" LIMIT 25',
                connection=conn,
            )
            mo.md(f"_Preview of `{first}` (first 25 rows):_")

    preview_df
    return


if __name__ == "__main__":
    app.run()
