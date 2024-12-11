const dotenv = require("dotenv");
dotenv.config();

const {
	Client,
	GatewayIntentBits,
	ActionRowBuilder,
	ButtonBuilder,
	ButtonStyle,
	ApplicationCommandOptionType,
	EmbedBuilder,
	ApplicationCommandType,
	Collection,
} = require("discord.js");
const {
	joinVoiceChannel,
	createAudioPlayer,
	createAudioResource,
	NoSubscriberBehavior,
	VoiceConnectionStatus,
	entersState,
	StreamType,
	AudioPlayerStatus,
} = require("@discordjs/voice");
const play = require("play-dl");
const SpotifyWebApi = require("spotify-web-api-node");
const YandexMusicApi = require("yandex-music-api");
const yandexMusic = new YandexMusicApi();
const dns = require("dns");
dns.setDefaultResultOrder("ipv4first");

const client = new Client({
	intents: [
		GatewayIntentBits.Guilds,
		GatewayIntentBits.GuildMessages,
		GatewayIntentBits.MessageContent,
		GatewayIntentBits.GuildVoiceStates,
		GatewayIntentBits.GuildMembers,
		GatewayIntentBits.GuildPresences,
	],
});

client.commands = new Collection();

const slashCommands = [
	{
		name: "play",
		description: "Воспроизвести музыку",
		type: ApplicationCommandType.ChatInput,
		options: [
			{
				name: "query",
				description: "Ссылка на трек или название",
				type: ApplicationCommandOptionType.String,
				required: true,
			},
		],
	},
	{
		name: "skip",
		description: "Пропустить текущий трек",
		type: ApplicationCommandType.ChatInput,
	},
	{
		name: "pause",
		description: "Приостановить воспроизведение",
		type: ApplicationCommandType.ChatInput,
	},
	{
		name: "resume",
		description: "Возобновить воспроизведение",
		type: ApplicationCommandType.ChatInput,
	},
	{
		name: "stop",
		description: "Остановить воспроизведение",
		type: ApplicationCommandType.ChatInput,
	},
];

const queue = new Map();

const spotifyApi = new SpotifyWebApi({
	clientId: process.env.SPOTIFY_CLIENT_ID,
	clientSecret: process.env.SPOTIFY_CLIENT_SECRET,
});

async function refreshSpotifyToken() {
	try {
		const data = await spotifyApi.clientCredentialsGrant();
		spotifyApi.setAccessToken(data.body["access_token"]);
		setTimeout(refreshSpotifyToken, (data.body["expires_in"] - 60) * 1000);
	} catch (error) {
		console.error("Ошибка при обновлении токена Spotify:", error);
	}
}

refreshSpotifyToken();

async function initYandexMusic() {
	try {
		await yandexMusic.init({ token: process.env.YANDEX_MUSIC_TOKEN });
		console.log("Яндекс Музыка успешно инициализирована");
	} catch (error) {
		console.error("Ошибка при инициализации Яндекс Музыки:", error);
	}
}

initYandexMusic();

client.once("ready", () => {
	console.log("Бот готов к работе!");
	queue.clear();
});

process.on("SIGINT", async () => {
	console.log("Бот выключается, очищаем очереди...");
	for (const [_, serverQueue] of queue) {
		if (serverQueue.lastMessage) {
			try {
				await serverQueue.lastMessage.delete();
			} catch (error) {
				console.error("Ошибка при удалении сообщения:", error);
			}
		}
		if (serverQueue.connection) {
			if (serverQueue.player) {
				serverQueue.player.stop();
				serverQueue.player.removeAllListeners();
			}
			try {
				serverQueue.connection.destroy();
				await new Promise((resolve) => setTimeout(resolve, 1000));
			} catch (error) {
				console.error("Ошибка при отключении от канала:", error);
			}
		}
	}
	queue.clear();
	process.exit(0);
});

process.on("beforeExit", async () => {
	console.log("Бот завершает работу, очищаем ресурсы...");
	for (const [_, serverQueue] of queue) {
		if (serverQueue.connection) {
			if (serverQueue.player) {
				serverQueue.player.stop();
				serverQueue.player.removeAllListeners();
			}
			serverQueue.connection.destroy();
		}
	}
	queue.clear();
});

client.on("disconnect", async () => {
	console.log("Бот отключается от Discord...");
	for (const [_, serverQueue] of queue) {
		if (serverQueue.connection) {
			if (serverQueue.player) {
				serverQueue.player.stop();
				serverQueue.player.removeAllListeners();
			}
			serverQueue.connection.destroy();
		}
	}
	queue.clear();
});

client.on("messageCreate", async (message) => {
	if (message.author.bot) return;
	if (!message.content.startsWith("!")) return;

	const args = message.content.slice(1).split(" ");
	const command = args.shift().toLowerCase();

	const serverQueue = queue.get(message.guild.id);

	if (command === "play") {
		const query = args.join(" ");

		if (!message.member.voice.channel) {
			return message.reply("Вы должны находиться в голосовом канале!");
		}

		try {
			let songInfo;

			if (query.includes("spotify.com")) {
				await message.reply("Загрузка трека из Spotify...");

				const trackId = query.split("/track/")[1].split("?")[0];

				const trackData = await spotifyApi.getTrack(trackId);
				const track = trackData.body;

				const searchResult = await play.search(
					`${track.name} ${track.artists[0].name}`,
					{ limit: 1 }
				);

				if (!searchResult || searchResult.length === 0) {
					return message.reply("Не удалось найти трек на YouTube!");
				}

				songInfo = {
					name: `${track.name} - ${track.artists[0].name}`,
					url: searchResult[0].url,
				};
			} else if (query.includes("youtube.com") || query.includes("youtu.be")) {
				await message.reply("Загрузка трека с YouTube...");
				try {
					const video = await play.video_info(query);
					songInfo = {
						name: video.video_details.title,
						url: video.video_details.url,
					};
				} catch (error) {
					console.error("Ошибка при получении информации с YouTube:", error);
					return message.reply("Не удалось загрузить трек с YouTube!");
				}
			} else if (query.includes("music.yandex.ru")) {
				await message.reply("Загрузка трека из Яндекс Музыки...");

				const trackId = query.split("track/")[1].split("?")[0];

				try {
					const trackInfo = await yandexMusic.getTrack(trackId);
					const trackData = trackInfo.result[0];

					const downloadInfo = await yandexMusic.getTrackDownloadInfo(trackId);
					const directUrl = await yandexMusic.getDirectLink(
						downloadInfo[0].downloadInfoUrl
					);

					songInfo = {
						name: `${trackData.title} - ${trackData.artists[0].name}`,
						url: directUrl,
						isYandex: true,
					};
				} catch (error) {
					console.error("Ошибка при получении трека из Яндекс Музыки:", error);
					return message.reply("Не удалось загрузить трек из Яндекс Музыки!");
				}
			} else {
				return message.reply(
					"Поддерживаются только ссылки с YouTube, Spotify и Яндекс Музыки!"
				);
			}

			if (!serverQueue) {
				const queueContruct = {
					textChannel: message.channel,
					voiceChannel: message.member.voice.channel,
					connection: null,
					player: null,
					songs: [],
					volume: 1,
					playing: true,
					timeout: null,
					lastMessage: null,
				};

				queueContruct.songs.push(songInfo);

				queue.set(message.guild.id, queueContruct);

				try {
					const connection = joinVoiceChannel({
						channelId: message.member.voice.channel.id,
						guildId: message.guild.id,
						adapterCreator: message.guild.voiceAdapterCreator,
						selfDeaf: true,
						selfMute: false,
					});

					queueContruct.connection = connection;

					await entersState(connection, VoiceConnectionStatus.Ready, 30_000);

					playSong(message.guild, queueContruct.songs[0]);
				} catch (err) {
					console.error(err);
					queue.delete(message.guild.id);
					return message.channel.send(
						"Не удалось подключиться к голосовому каналу!"
					);
				}
			} else {
				serverQueue.songs.push(songInfo);

				if (!serverQueue.player || serverQueue.player.state.status === "idle") {
					playSong(message.guild, serverQueue.songs[0]);
				}

				return message.channel.send(
					`Трек **${songInfo.name}** добавлен в очередь!`
				);
			}
		} catch (error) {
			console.error(error);
			message.channel.send("Произошла ошибка при воспроизведении!");
		}
	} else if (command === "skip") {
		if (!message.member.voice.channel)
			return message.channel.send("Вы должны находиться в голосовом канале!");
		if (!serverQueue)
			return message.channel.send(
				"Сейчас нет воспроизводимых треков, которые можно пропустить!"
			);

		serverQueue.player.stop();
		message.channel.send("Трек пропущен!");

		if (serverQueue.songs.length > 0) {
			playSong(message.guild, serverQueue.songs[0]);
		}
	} else if (command === "pause") {
		if (!message.member.voice.channel)
			return message.channel.send("Вы должны находиться в голосовом канале!");
		if (!serverQueue)
			return message.channel.send("Сейчас нет воспроизводимого трека!");

		if (serverQueue.player.pause()) {
			message.channel.send("Воспроизведение приостановлено!");
		} else {
			message.channel.send("Не удалось приостановить воспроизведение!");
		}
	} else if (command === "resume") {
		if (!message.member.voice.channel)
			return message.channel.send("Вы должны находиться в голосовом канале!");
		if (!serverQueue)
			return message.channel.send("Сейчас нет воспроизводимого трека!");

		if (serverQueue.player.unpause()) {
			message.channel.send("Воспроизведение возобновлено!");
		} else {
			message.channel.send("Не удалось возобновить воспроизведение!");
		}
	} else if (command === "stop") {
		if (!message.member.voice.channel)
			return message.channel.send("Вы должны находиться в голосовом канале!");
		if (!serverQueue)
			return message.channel.send("Сейчас нет воспроизводимого трека!");

		if (serverQueue.lastMessage) {
			try {
				await serverQueue.lastMessage.delete();
			} catch (error) {
				console.error("Ошибка при удалении сообщения:", error);
			}
			serverQueue.lastMessage = null;
		}

		serverQueue.songs = [];
		serverQueue.player.stop();
		queue.delete(message.guild.id);
		return message.channel.send("Воспроизведение остановлено!");
	} else if (command === "help") {
		const helpEmbed = new EmbedBuilder()
			.setColor("#0099ff")
			.setTitle("Команды музыкального бота")
			.setDescription("Список доступных команд:")
			.addFields(
				commands.map((cmd) => ({
					name: cmd.usage,
					value: `${cmd.description}\nПример: \`${cmd.example}\``,
					inline: false,
				}))
			);

		message.channel.send({ embeds: [helpEmbed] });
	}

	if (message.content === "!") {
		const helpEmbed = new EmbedBuilder()
			.setColor("#0099ff")
			.setTitle("Доступные команды")
			.setDescription("Введите одну из следующих команд:")
			.addFields(
				commands.map((cmd) => ({
					name: cmd.usage,
					value: cmd.description,
					inline: true,
				}))
			)
			.setFooter({
				text: "Для подробной информации используйте команду !help",
			});

		const msg = await message.channel.send({ embeds: [helpEmbed] });

		setTimeout(() => {
			msg.delete().catch(console.error);
		}, 10000);
	}
});

async function playSong(guild, song) {
	const serverQueue = queue.get(guild.id);

	if (!serverQueue) return;

	if (!song) {
		if (serverQueue.lastMessage) {
			try {
				await serverQueue.lastMessage.delete();
			} catch (error) {
				console.error("Ошибка при удалении сообщения:", error);
			}
		}
		serverQueue.connection.destroy();
		queue.delete(guild.id);
		serverQueue.textChannel
			.send("Очередь воспроизведения пуста!")
			.then((msg) => setTimeout(() => msg.delete().catch(console.error), 5000));
		return;
	}

	if (serverQueue.timeout) {
		clearTimeout(serverQueue.timeout);
		serverQueue.timeout = null;
	}

	let resource;

	try {
		let stream;
		if (song.isYandex) {
			try {
				stream = await fetch(song.url).then((res) => res.body);
				if (!stream)
					throw new Error("Не удалось получить поток для Яндекс Музыки");

				resource = createAudioResource(stream, {
					inputType: StreamType.Arbitrary,
					inlineVolume: true,
				});
			} catch (error) {
				console.error("Ошибка при получении потока Яндекс Музыки:", error);
				throw error;
			}
		} else {
			let attempts = 3;
			while (attempts > 0) {
				try {
					console.log("Попытка получения потока YouTube:", attempts);
					const streamInfo = await play.stream(song.url);

					if (!streamInfo || !streamInfo.stream) {
						throw new Error("Поток YouTube пуст или недействителен");
					}

					stream = streamInfo.stream;

					console.log("Поток получен успешно:", !!stream);

					resource = createAudioResource(stream, {
						inputType: StreamType.Opus,
						inlineVolume: true,
					});
					break;
				} catch (error) {
					console.error(
						`Ошибка при получении потока (попытка ${4 - attempts}/3):`,
						error
					);
					attempts--;
					if (attempts === 0) throw error;
					await new Promise((resolve) => setTimeout(resolve, 2000));
				}
			}
		}
	} catch (error) {
		console.error("Критическая ошибка при создании аудиоресурса:", error);
		serverQueue.textChannel.send(
			"Произошла ошибка при воспроизведении трека. Пропускаю..."
		);
		serverQueue.songs.shift();
		playSong(guild, serverQueue.songs[0]);
		return;
	}

	if (!resource) {
		console.error("Ресурс не был создан");
		serverQueue.textChannel.send(
			"Не удалось создать аудиоресурс. Пропускаю трек..."
		);
		serverQueue.songs.shift();
		playSong(guild, serverQueue.songs[0]);
		return;
	}

	resource.volume?.setVolume(serverQueue.volume);

	const player = createAudioPlayer({
		behaviors: {
			noSubscriber: NoSubscriberBehavior.Play,
		},
	});

	player.on("stateChange", (oldState, newState) => {
		console.log(
			`Состояние плеера изменилось с ${oldState.status} на ${newState.status}`
		);
		if (
			newState.status === AudioPlayerStatus.Idle &&
			oldState.status !== AudioPlayerStatus.Idle
		) {
			serverQueue.songs.shift();
			playSong(guild, serverQueue.songs[0]);
		}
	});

	player.on("error", (error) => {
		console.error("Ошибка плеера:", error);
		serverQueue.songs.shift();
		playSong(guild, serverQueue.songs[0]);
	});

	serverQueue.connection.subscribe(player);
	serverQueue.player = player;

	player.play(resource);

	console.log("Текущее состояние плеера:", player.state.status);

	const row = new ActionRowBuilder().addComponents(
		new ButtonBuilder()
			.setCustomId("pause_resume")
			.setLabel("⏯️ Пауза/Продолжить")
			.setStyle(ButtonStyle.Primary),
		new ButtonBuilder()
			.setCustomId("skip")
			.setLabel("⏭️ Пропустить")
			.setStyle(ButtonStyle.Secondary),
		new ButtonBuilder()
			.setCustomId("stop")
			.setLabel("⏹️ Остановить")
			.setStyle(ButtonStyle.Danger)
	);

	if (serverQueue.lastMessage) {
		try {
			await serverQueue.lastMessage.delete();
		} catch (error) {
			console.error("Ошибка при удалении предыдущего сообщения:", error);
		}
	}

	const newMessage = await serverQueue.textChannel.send({
		content: `🎵 Сейчас играет: **${song.name}**\nСтатус: ▶️ Воспроизводится`,
		components: [row],
	});
	serverQueue.lastMessage = newMessage;

	player.on("stateChange", (oldState, newState) => {
		if (newState.status === "idle" && oldState.status !== "idle") {
			serverQueue.songs.shift();
			if (serverQueue.songs[0]) {
				serverQueue.textChannel
					.send(`🎵 Начинаю воспроизведение: **${serverQueue.songs[0].name}**`)
					.then((msg) =>
						setTimeout(() => msg.delete().catch(console.error), 5000)
					);
			}
			playSong(guild, serverQueue.songs[0]);
		}
	});

	player.on("error", (error) => {
		console.error("Ошибка плеера:", error);
		serverQueue.songs.shift();
		playSong(guild, serverQueue.songs[0]);
	});

	serverQueue.connection.on("stateChange", (oldState, newState) => {
		console.log(
			`Состояние соединения изменилось с ${oldState.status} на ${newState.status}`
		);
	});
}

client.on("interactionCreate", async (interaction) => {
	if (!interaction.isButton()) return;

	try {
		const serverQueue = queue.get(interaction.guildId);
		if (!serverQueue) {
			return await interaction.reply({
				content: "В данный момент ничего не воспроизводится!",
				ephemeral: true,
			});
		}

		if (!interaction.member.voice.channel) {
			return await interaction.reply({
				content: "Вы должны находиться в голосовом канале!",
				ephemeral: true,
			});
		}

		const row = new ActionRowBuilder().addComponents(
			new ButtonBuilder()
				.setCustomId("pause_resume")
				.setLabel("⏯️ Пауза/Продолжить")
				.setStyle(ButtonStyle.Primary),
			new ButtonBuilder()
				.setCustomId("skip")
				.setLabel("⏭️ Пропустить")
				.setStyle(ButtonStyle.Secondary),
			new ButtonBuilder()
				.setCustomId("stop")
				.setLabel("⏹️ Остановить")
				.setStyle(ButtonStyle.Danger)
		);

		switch (interaction.customId) {
			case "pause_resume":
				try {
					if (serverQueue.player.state.status === "playing") {
						serverQueue.player.pause();
						await interaction.reply({
							content: "Воспроизведение приостановлено!",
							ephemeral: true,
						});
						await serverQueue.lastMessage.edit({
							content: `🎵 Сейчас играет: **${serverQueue.songs[0].name}**\nСтатус: ⏸️ На паузе`,
							components: [row],
						});
					} else {
						serverQueue.player.unpause();
						await interaction.reply({
							content: "Воспроизведение возобновлено!",
							ephemeral: true,
						});
						await serverQueue.lastMessage.edit({
							content: `🎵 Сейчас играет: **${serverQueue.songs[0].name}**\nСтатус: ▶️ Воспроизводится`,
							components: [row],
						});
					}
				} catch (error) {
					console.error("Ошибка при обработке pause_resume:", error);
					if (!interaction.replied) {
						await interaction.reply({
							content:
								"Произошла ошибка при изменении состояния воспроизведения!",
							ephemeral: true,
						});
					}
				}
				break;

			case "skip":
				try {
					if (serverQueue.lastMessage) {
						await serverQueue.lastMessage.delete().catch(console.error);
						serverQueue.lastMessage = null;
					}

					serverQueue.songs.shift();
					serverQueue.player.stop();

					if (serverQueue.songs.length === 0) {
						queue.delete(interaction.guildId);
						await interaction.reply({
							content: "Больше нет треков в очереди!",
							ephemeral: true,
						});
						return;
					}

					await interaction.reply({
						content: "Трек пропущен!",
						ephemeral: true,
					});

					playSong(interaction.guild, serverQueue.songs[0]);
				} catch (error) {
					console.error("Ошибка при обработке skip:", error);
					if (!interaction.replied) {
						await interaction.reply({
							content: "Произошла ошибка при пропуске трека!",
							ephemeral: true,
						});
					}
				}
				break;

			case "stop":
				try {
					if (serverQueue.lastMessage) {
						await serverQueue.lastMessage.delete().catch(console.error);
						serverQueue.lastMessage = null;
					}
					serverQueue.songs = [];
					serverQueue.player.stop();
					queue.delete(interaction.guildId);
					await interaction.reply({
						content: "Воспроизведение остановлено!",
						ephemeral: true,
					});
				} catch (error) {
					console.error("Ошибка при обработке stop:", error);
					if (!interaction.replied) {
						await interaction.reply({
							content: "Произошла ошибка при остановке воспроизведения!",
							ephemeral: true,
						});
					}
				}
				break;
		}
	} catch (error) {
		console.error("Общая ошибка при обработке интеракции:", error);
		if (!interaction.replied) {
			try {
				await interaction.reply({
					content: "Произошла ошибка при обработке команды!",
					ephemeral: true,
				});
			} catch (replyError) {
				console.error("Не удалось отправить сообщение об ошибке:", replyError);
			}
		}
	}
});

client.on("error", (error) => {
	console.error("Ошибка клиента Discord:", error);
});

client.on("warn", (warning) => {
	console.warn("Предупреждение клиента Discord:", warning);
});

client.login(process.env.DISCORD_TOKEN);

const commands = [
	{
		name: "play",
		description: "Воспроизвести музыку по ссылке или названию",
		usage: "!play <ссылка или название>",
		example: "!play https://www.youtube.com/watch?v=dQw4w9WgXcQ",
	},
	{
		name: "skip",
		description: "Пропустить текущий трек",
		usage: "!skip",
		example: "!skip",
	},
	{
		name: "pause",
		description: "Приостановить воспроизведение",
		usage: "!pause",
		example: "!pause",
	},
	{
		name: "resume",
		description: "Возобновить воспроизведение",
		usage: "!resume",
		example: "!resume",
	},
	{
		name: "stop",
		description: "Остановить воспроизведение",
		usage: "!stop",
		example: "!stop",
	},
];
