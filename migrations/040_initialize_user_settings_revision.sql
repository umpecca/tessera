UPDATE user_settings SET revision = lower(hex(randomblob(16))) WHERE revision = '';
