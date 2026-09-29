-- Target server has different TimeZone/DateStyle/float settings; data is identical
ALTER DATABASE :db SET TimeZone = 'Asia/Kolkata';
ALTER DATABASE :db SET DateStyle = 'SQL, DMY';
ALTER DATABASE :db SET extra_float_digits = 0;
