const { Client, GatewayIntentBits, EmbedBuilder, ChannelType, PermissionsBitField } = require('discord.js');
const { joinVoiceChannel, createAudioPlayer, createAudioResource, NoSubscriberBehavior, AudioPlayerStatus, entersState, VoiceConnectionStatus, StreamType } = require('@discordjs/voice');
const fs = require('fs');
const path = require('path');

// إعداد مكتبة الصوت - حاول استخدام @discordjs/opus أولاً ثم opusscript كاحتياط
try {
    require('@discordjs/opus');
    console.log('✅ مكتبة الصوت جاهزة باستخدام @discordjs/opus');
} catch (e1) {
    try {
        const OpusScript = require('opusscript');
        const encoder = new OpusScript(48000, 2, OpusScript.Application.AUDIO);
        console.log('✅ مكتبة الصوت جاهزة باستخدام opusscript');
    } catch (e2) {
        console.warn('⚠️  لا توجد مكتبة opus متاحة:', e1.message, '/', e2.message);
    }
}


// الإعدادات

const config = {
    token: process.env.DISCORD_TOKEN,
    supportCategoryId: process.env.SUPPORT_CATEGORY_ID,
    supportVoiceId: process.env.SUPPORT_VOICE_ID,
    supportTextId: process.env.SUPPORT_TEXT_ID,
    adminRoleId: process.env.ADMIN_ROLE_ID
};

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers
    ]
});

// تخزين البيانات
const activeCalls = new Map();
const voiceConnections = new Map();
const privateRooms = new Map();

// دالة لإنشاء اتصال صوتي
async function getOrCreateConnection(channel) {
    try {
        const guildId = channel.guild.id;
        
        if (voiceConnections.has(guildId)) {
            const conn = voiceConnections.get(guildId);
            try {
                if (conn && conn.state && conn.state.status !== VoiceConnectionStatus.Destroyed) {
                    return conn;
                }
            } catch (err) {
                // استمر لإنشاء اتصال جديد إذا كانت حالة الاتصال غير قابلة للقراءة
            }
        }

        console.log(`🔊 إنشاء اتصال صوتي جديد في ${channel.name}`);
        const connection = joinVoiceChannel({
            channelId: channel.id,
            guildId: guildId,
            adapterCreator: channel.guild.voiceAdapterCreator,
            selfDeaf: false,
            selfMute: false
        });

        voiceConnections.set(guildId, connection);
        return connection;
        
    } catch (error) {
        console.error('❌ خطأ في الاتصال الصوتي:', error);
        return null;
    }
}

// دالة تشغيل الصوت
function playAudio(connection, fileName, userId, shouldLoop = false) {
    try {
        const soundPath = path.join(__dirname, fileName);
        if (!fs.existsSync(soundPath)) {
            console.log(`❌ ملف ${fileName} مش موجود`);
            return null;
        }

        const input = fs.createReadStream(soundPath);
        const resource = createAudioResource(input, {
            inputType: StreamType.Arbitrary,
            inlineVolume: true
        });

        const player = createAudioPlayer({
            behaviors: {
                noSubscriber: NoSubscriberBehavior.Pause
            }
        });

        player.play(resource);
        try { connection.subscribe(player); } catch (err) { console.warn('⚠️ فشل الاشتراك بالمشغل:', err.message); }

        if (shouldLoop && fileName === 'background_music.mp3') {
            player.on(AudioPlayerStatus.Idle, () => {
                if (activeCalls.has(userId)) {
                    const callData = activeCalls.get(userId);
                    if (!callData.isBotMuted) {
                        console.log(`🔄 تكرار الموسيقى للعميل ${userId}`);
                        playAudio(connection, 'background_music.mp3', userId, true);
                    }
                }
            });
        }

        return player;

    } catch (error) {
        console.error(`❌ خطأ في تشغيل ${fileName}:`, error);
        return null;
    }
}

// دالة لوقف الصوت
function stopAllAudioForUser(userId) {
    const callData = activeCalls.get(userId);
    if (!callData) return;
    
    if (callData.musicPlayer) {
        callData.musicPlayer.stop();
    }
    if (callData.waitingPlayer) {
        callData.waitingPlayer.stop();
    }
}

// دالة لإنشاء روم صوتي خاص
async function createPrivateVoiceRoom(guild, userId, clientName, adminId, adminName) {
    try {
        console.log(`🆕 إنشاء روم صوتي خاص للعميل ${clientName}`);
        
        let category;
        try {
            category = await guild.channels.fetch(config.supportCategoryId);
        } catch (error) {
            category = null;
        }
        
        const cleanClientName = clientName.replace(/[^\w\u0600-\u06FF]/g, '-').substring(0, 15);
        const roomNumber = Math.floor(Math.random() * 1000);
        
        const voiceChannel = await guild.channels.create({
            name: `Supp-${cleanClientName}-${roomNumber}`,
            type: ChannelType.GuildVoice,
            parent: category ? category.id : null,
            permissionOverwrites: [
                {
                    id: guild.id,
                    deny: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.Connect]
                },
                {
                    id: userId,
                    allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.Connect, PermissionsBitField.Flags.Speak]
                },
                {
                    id: adminId,
                    allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.Connect, PermissionsBitField.Flags.Speak, PermissionsBitField.Flags.MoveMembers]
                },
                {
                    id: config.adminRoleId,
                    allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.Connect, PermissionsBitField.Flags.Speak]
                }
            ]
        });
        
        console.log(`✅ تم إنشاء الروم: ${voiceChannel.name}`);
        return voiceChannel;
        
    } catch (error) {
        console.error('❌ خطأ في إنشاء الروم الخاص:', error);
        return null;
    }
}

// دالة لنقل الأعضاء للروم الخاص
async function moveToPrivateRoom(guild, userId, adminId, privateRoomId) {
    try {
        console.log(`🚚 نقل الأعضاء للروم الخاص`);
        
        const privateRoom = await guild.channels.fetch(privateRoomId);
        if (!privateRoom) {
            throw new Error('❌ الروم الخاص مش موجود');
        }
        
        // نقل العميل
        const clientMember = await guild.members.fetch(userId);
        if (clientMember.voice.channel) {
            await clientMember.voice.setChannel(privateRoomId);
            console.log(`✅ تم نقل العميل ${clientMember.user.tag}`);
        }
        
        // نقل المشرف
        const adminMember = await guild.members.fetch(adminId);
        if (adminMember.voice.channel) {
            await adminMember.voice.setChannel(privateRoomId);
            console.log(`✅ تم نقل المشرف ${adminMember.user.tag}`);
        }
        
        return true;
        
    } catch (error) {
        console.error('❌ خطأ في نقل الأعضاء:', error);
        return false;
    }
}

// دالة لحذف الروم الخاص
async function deletePrivateRoom(guild, roomId) {
    try {
        const room = await guild.channels.fetch(roomId);
        if (room) {
            await room.delete('انتهت المكالمة');
            console.log(`🗑️ تم حذف الروم الخاص: ${room.name}`);
            return true;
        }
    } catch (error) {
        return false;
    }
}

// دالة لإرسال إشعار طلب جديد
async function sendNewCallNotification(userId, userName) {
    try {
        const textChannel = await client.channels.fetch(config.supportTextId);
        if (!textChannel) return;
        
        const embed = new EmbedBuilder()
            .setColor(0x3498db)
            .setTitle('📞 طلب دعم صوتي جديد')
            .setDescription(`**يوجد عميل في انتظار الدعم**`)
            .addFields(
                { name: '👤 العميل', value: `${userName}\n<@${userId}>`, inline: true },
                { name: '🕐 الوقت', value: `<t:${Math.floor(Date.now()/1000)}:R>`, inline: true },
                { name: '📍 المكان', value: '<#' + config.supportVoiceId + '>', inline: true }
            )
            .setFooter({ text: 'الرجاء التوجه للروم الصوتي لتولي الطلب' })
            .setTimestamp();
        
        await textChannel.send({
            content: `<@&${config.adminRoleId}> 📢 عميل في انتظار الدعم!`,
            embeds: [embed]
        });
        
        console.log(`📤 تم إرسال إشعار طلب جديد للعميل ${userName}`);
        
    } catch (error) {
        console.error('❌ خطأ في إرسال إشعار الطلب:', error);
    }
}

// دالة لإرسال إشعار استلام الطلب
async function sendAdminAcceptNotification(userId, adminId, adminName, clientName) {
    try {
        const textChannel = await client.channels.fetch(config.supportTextId);
        if (!textChannel) return;
        
        const embed = new EmbedBuilder()
            .setColor(0x2ecc71)
            .setTitle('✅ تم استلام الطلب')
            .setDescription(`**تم تولي طلب الدعم بنجاح**`)
            .addFields(
                { name: '👤 العميل', value: `${clientName}\n<@${userId}>`, inline: true },
                { name: '👑 المشرف', value: `${adminName}\n<@${adminId}>`, inline: true },
                { name: '⏰ الوقت', value: `<t:${Math.floor(Date.now()/1000)}:R>`, inline: true }
            )
            .setTimestamp();
        
        await textChannel.send({ 
            content: `📢 **تم استلام الطلب**\nالمشرف <@${adminId}> استلم طلب <@${userId}>`,
            embeds: [embed] 
        });
        
        console.log(`📤 تم إرسال إشعار استلام الطلب`);
        
    } catch (error) {
        console.error('❌ خطأ في إرسال إشعار الاستلام:', error);
    }
}

// دالة للتحقق من وجود مشرف في الروم
function getAdminInVoice(channel) {
    if (!channel) return null;
    return channel.members.find(member => 
        member.roles.cache.has(config.adminRoleId) && !member.user.bot
    );
}

// حدث دخول الروم الصوتي
client.on('voiceStateUpdate', async (oldState, newState) => {
    try {
        const member = newState.member;
        if (!member || member.user.bot) return;
        
        const voiceChannel = newState.channel;
        
        // دخول روم الانتظار
        if (newState.channelId === config.supportVoiceId && newState.channelId !== oldState.channelId) {
            // لو دخل مشرف
            if (member.roles.cache.has(config.adminRoleId)) {
                console.log(`👑 ${member.user.tag} (إدارة) دخل روم الانتظار`);
                
                const clientsInRoom = voiceChannel.members.filter(m => 
                    !m.user.bot && !m.roles.cache.has(config.adminRoleId)
                );
                
                // لكل عميل في روم الانتظار
                for (const clientMember of clientsInRoom.values()) {
                    const clientId = clientMember.id;
                    const callData = activeCalls.get(clientId);
                    
                    if (callData && !callData.hasAdmin && !callData.privateRoomId) {
                        console.log(`🔄 بدء عملية إنشاء روم خاص للعميل ${clientMember.user.tag}`);
                        
                        // 1. أوقف الموسيقى للعميل
                        callData.isBotMuted = true;
                        if (callData.musicPlayer) {
                            callData.musicPlayer.stop();
                        }
                        
                        // 2. إرسال إشعار استلام الطلب
                        await sendAdminAcceptNotification(
                            clientId,
                            member.id,
                            member.user.tag,
                            clientMember.user.tag
                        );
                        
                        // 3. إنشاء روم صوتي خاص
                        const privateRoom = await createPrivateVoiceRoom(
                            voiceChannel.guild,
                            clientId,
                            clientMember.user.username,
                            member.id,
                            member.user.tag
                        );
                        
                        if (privateRoom) {
                            // 4. حفظ بيانات الروم الخاص
                            callData.privateRoomId = privateRoom.id;
                            callData.privateRoomName = privateRoom.name;
                            callData.lastAdminId = member.id;
                            callData.hasAdmin = true;
                            callData.callStartTime = Date.now();
                            callData.adminName = member.user.tag;
                            
                            privateRooms.set(privateRoom.id, {
                                clientId: clientId,
                                clientName: clientMember.user.tag,
                                adminId: member.id,
                                adminName: member.user.tag,
                                createdAt: Date.now()
                            });
                            
                            // 5. نقل العميل والمشرف للروم الخاص
                            const moved = await moveToPrivateRoom(
                                voiceChannel.guild,
                                clientId,
                                member.id,
                                privateRoom.id
                            );
                            
                            if (moved) {
                                console.log(`✅ تم نقل ${clientMember.user.tag} و ${member.user.tag} للروم الخاص`);
                                
                                // 6. البوت يطلع من روم الانتظار
                                setTimeout(async () => {
                                    const guildId = voiceChannel.guild.id;
                                    const conn = voiceConnections.get(guildId);
                                    if (conn) {
                                        conn.destroy();
                                        voiceConnections.delete(guildId);
                                        console.log(`🔌 البوت طلع من روم الانتظار`);
                                    }
                                }, 2000);
                            }
                        }
                        
                        break; // نتعامل مع عميل واحد فقط
                    }
                }
                
                return;
            }
            
            // دخول عميل لروم الانتظار
            console.log(`👤 ${member.user.tag} دخل روم الانتظار`);
            
            if (!voiceChannel) return;
            
            // التحقق إذا فيه مشرف موجود
            const existingAdmin = getAdminInVoice(voiceChannel);
            
            // إذا فيه مشرف موجود، نبدأ عملية إنشاء روم خاص فوراً
            if (existingAdmin) {
                console.log(`⚡ العميل ${member.user.tag} دخل ومشرف موجود بالفعل`);
                
                // إرسال إشعار استلام الطلب فوراً
                await sendAdminAcceptNotification(
                    member.id,
                    existingAdmin.id,
                    existingAdmin.user.tag,
                    member.user.tag
                );
                
                // إنشاء روم صوتي خاص فوراً
                const privateRoom = await createPrivateVoiceRoom(
                    voiceChannel.guild,
                    member.id,
                    member.user.username,
                    existingAdmin.id,
                    existingAdmin.user.tag
                );
                
                if (privateRoom) {
                    // حفظ بيانات العميل
                    const callData = {
                        userId: member.id,
                        voiceChannelId: voiceChannel.id,
                        guildId: voiceChannel.guild.id,
                        isBotMuted: true,
                        hasAdmin: true,
                        lastAdminId: existingAdmin.id,
                        adminName: existingAdmin.user.tag,
                        userName: member.user.tag,
                        joinedAt: Date.now(),
                        privateRoomId: privateRoom.id,
                        privateRoomName: privateRoom.name,
                        callStartTime: Date.now()
                    };
                    
                    activeCalls.set(member.id, callData);
                    privateRooms.set(privateRoom.id, {
                        clientId: member.id,
                        clientName: member.user.tag,
                        adminId: existingAdmin.id,
                        adminName: existingAdmin.user.tag,
                        createdAt: Date.now()
                    });
                    
                    // نقل العميل والمشرف للروم الخاص
                    await moveToPrivateRoom(
                        voiceChannel.guild,
                        member.id,
                        existingAdmin.id,
                        privateRoom.id
                    );
                    
                    console.log(`✅ تم إنشاء روم خاص فوراً للعميل ${member.user.tag}`);
                }
                
                return;
            }
            
            // إذا مفيش مشرف، نبدأ عملية الانتظار
            
            // 1. البوت يدخل مع العميل فوراً
            const connection = await getOrCreateConnection(voiceChannel);
            if (!connection) {
                console.error('❌ فشل الاتصال الصوتي');
                return;
            }
            
            // زيادة المهلة لتفادي اخطاء الشبكة الصغيرة
            await entersState(connection, VoiceConnectionStatus.Ready, 10000);
            
            // 2. إرسال إشعار طلب جديد
            await sendNewCallNotification(member.id, member.user.tag);
            
            // 3. الانتظار 4 ثواني فقط ثم تشغيل التسجيلات
            setTimeout(async () => {
                if (!member.voice.channelId || member.voice.channelId !== config.supportVoiceId) {
                    console.log(`❌ العميل ${member.user.tag} خرج قبل بدء الصوت`);
                    return;
                }
                
                // تشغيل صوت الانتظار
                console.log(`🔊 تشغيل صوت الانتظار للعميل ${member.id}`);
                const waitingPlayer = playAudio(connection, 'waiting_call.mp3', member.id, false);
                
                // حفظ بيانات العميل
                const callData = {
                    connection,
                    waitingPlayer,
                    userId: member.id,
                    voiceChannelId: voiceChannel.id,
                    guildId: voiceChannel.guild.id,
                    isBotMuted: false,
                    hasAdmin: false,
                    userName: member.user.tag,
                    joinedAt: Date.now()
                };
                
                // استمع لانتهاء صوت الانتظار ثم ابدأ الموسيقى
                if (waitingPlayer) {
                    waitingPlayer.once(AudioPlayerStatus.Idle, () => {
                        if (member.voice.channelId === config.supportVoiceId) {
                            const currentAdmin = getAdminInVoice(voiceChannel);
                            if (!currentAdmin) {
                                console.log(`🎵 بدء موسيقى الانتظار للعميل ${member.id}`);
                                const musicPlayer = playAudio(connection, 'background_music.mp3', member.id, true);
                                callData.musicPlayer = musicPlayer;
                                callData.waitingPlayer = null;
                            }
                        }
                    });
                }
                
                activeCalls.set(member.id, callData);
                
            }, 4000); // 4 ثواني فقط
            
        }
        
        // خروج من روم الانتظار أو الروم الخاص
        if (oldState.channelId && newState.channelId !== oldState.channelId) {
            const memberId = member.id;
            const memberName = member.user.tag;
            
            // البحث إذا الروم اللي طلع منه ده روم خاص
            const isPrivateRoom = privateRooms.has(oldState.channelId);
            
            // إذا كان روم خاص
            if (isPrivateRoom) {
                const roomData = privateRooms.get(oldState.channelId);
                
                // إذا العميل هو اللي طلع
                if (roomData.clientId === memberId) {
                    console.log(`👤 العميل خرج من الروم الخاص`);
                    
                    // جلب بيانات المكالمة
                    const callData = activeCalls.get(memberId);
                    if (callData) {
                        // تنظيف البيانات
                        activeCalls.delete(memberId);
                    }
                    
                    // حذف الروم الخاص بعد 3 ثواني
                    setTimeout(async () => {
                        await deletePrivateRoom(oldState.channel?.guild, oldState.channelId);
                        privateRooms.delete(oldState.channelId);
                    }, 3000);
                    
                } 
                // إذا المشرف هو اللي طلع
                else if (roomData.adminId === memberId) {
                    console.log(`👑 المشرف خرج من الروم الخاص`);
                    
                    // جلب بيانات المكالمة
                    const callData = activeCalls.get(roomData.clientId);
                    if (callData) {
                        // تنظيف البيانات
                        activeCalls.delete(roomData.clientId);
                    }
                    
                    // حذف الروم الخاص بعد 3 ثواني
                    setTimeout(async () => {
                        await deletePrivateRoom(oldState.channel?.guild, oldState.channelId);
                        privateRooms.delete(oldState.channelId);
                    }, 3000);
                }
                
                return;
            }
            
            // إذا كان روم الانتظار
            if (oldState.channelId === config.supportVoiceId) {
                // لو كان مشرف
                if (member.roles.cache.has(config.adminRoleId)) {
                    console.log(`👑 ${memberName} (إدارة) خرج من روم الانتظار`);
                    return;
                }
                
                // لو كان عميل
                console.log(`👤 ${memberName} خرج من روم الانتظار`);
                
                const callData = activeCalls.get(memberId);
                
                if (callData) {
                    // تنظيف الصوت
                    stopAllAudioForUser(memberId);
                    
                    // تنظيف البيانات
                    activeCalls.delete(memberId);
                }
                
                // إذا مفيش أحد في روم الانتظار، اقطع الاتصال
                setTimeout(async () => {
                    try {
                        const channel = await client.channels.fetch(config.supportVoiceId);
                        if (channel) {
                            const members = channel.members.filter(m => !m.user.bot);
                            
                            if (members.size === 0) {
                                const guildId = channel.guild.id;
                                const conn = voiceConnections.get(guildId);
                                if (conn) {
                                    conn.destroy();
                                    voiceConnections.delete(guildId);
                                    console.log(`🔌 البوت طلع من روم الانتظار (فارغ)`);
                                }
                            }
                        }
                    } catch (error) {
                        // تجاهل الخطأ
                    }
                }, 3000);
            }
        }
        
    } catch (error) {
        console.error('❌ خطأ في voiceStateUpdate:', error);
    }
});

// حدث تشغيل البوت
client.on('ready', async () => {
    console.log('=================================');
    console.log(`✅ ${client.user.tag} يعمل بنجاح!`);
    console.log(`📁 الكاتيجوري: ${config.supportCategoryId}`);
    console.log(`🎧 روم الانتظار: ${config.supportVoiceId}`);
    console.log(`💬 روم الإشعارات: ${config.supportTextId}`);
    console.log(`👑 رتبة الإدارة: ${config.adminRoleId}`);
    console.log('=================================');
    
    // تعيين حالة البوت
    client.user.setPresence({
        activities: [{
            name: 'System Support Ai',
            type: 2
        }],
        status: 'online'
    });
});

// تسجيل الدخول
if (!config.token) {
    console.error('❌ المتغير البيئي DISCORD_TOKEN غير معبأ. أضف التوكن ثم أعد التشغيل.');
    process.exit(1);
}
client.login(config.token).catch(err => console.error('❌ فشل تسجيل الدخول:', err));

// معالجة الأخطاء
process.on('unhandledRejection', error => {
    console.error('❌ خطأ غير معالج:', error);
});

process.on('uncaughtException', error => {
    console.error('❌ استثناء غير معالج:', error);
});

// تنظيف الاتصالات عند إيقاف العملية
process.on('SIGINT', async () => {
    console.log('🛑 إغلاق - تنظيف الاتصالات الصوتية');
    for (const [guildId, conn] of voiceConnections.entries()) {
        try { conn.destroy(); } catch (e) {}
        voiceConnections.delete(guildId);
    }
    process.exit(0);
});