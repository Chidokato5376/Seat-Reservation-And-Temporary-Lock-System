# Seat-Reservation-And-Temporary-Lock-System
This is the final report for the Advanced Database Project, create by group 3 from EP16A (National Economics University). Please contact me via address: tuannh2209@gmail.com if you want to know more information about this project.

INSTALLATION
=

1. PostgreSQL: https://www.postgresql.org/download/windows/

2. Redis:
- https://github.com/tporadowski/redis/releases/latest
- Download .msi file
- Command check: redis-cli ping ===> Output: PONG
- Check SETNX (Set if not exist):   redis-cli
                                    SET test "hello"
                                    GET test
                                    SETNX lock:seat:1 "user1"
                                    SETNX lock:seat:1 "user2"
                                    EXIT

3. Node.js:
- https://nodejs.org
- Download node-v22.x.x-x64.msi file
- Check command:    node -v     ===>        v22.x.x
                    npm -v      ===>        10.x.x
  
HOW TO EXECUTE THE PROJECT
=
1. Check requirement files:
- Run Command Prompt
- Enter: cd Downloads\seatbooking_database\seat-app
- Enter: dir
- Must display requirement files: server.js, package.json, .env, folder src, folder public

2. Change default password by your PostgreSQL password:
- Open VSCode
- Open the project's folder (seatbooking_database)
- Open VSCode Terminal (Ctrl + J or Ctrl + `)
- Enter: cd seat-app
- Copy the path (Ctrl + Shift + C) in VSCode Terminal 
    (Example: C:\Users\Asus\Downloads\seatbooking_database\seat-app>)
- Enter: notepad C:\Users\Asus\Downloads\seatbooking_database\seat-app\.env
- Change this line by your PostgreSQL password: PG_PASSWORD=your_PostgreSQL_password
- Save file (Ctrl + S)

3. Install Dependencies
- Open VSCode Terminal again
- Enter: cd seat-app
- Enter: npm install

4. Execute Program
- Run the SQL files with instructions in Run_Database.txt
- After finished installing dependencies (30s - 1m), open VSCode Terminal again
- Enter: cd seat-app
- Enter: npm start
- Open browser (Google Chrome)
- Enter: http://localhost:3000
