import * as moment from "moment-timezone";

import { GeoCoordinates, WeatherData, ZimmermanWateringData } from "../../types";
import { httpJSONRequest } from "../weather";
import { WeatherProvider } from "./WeatherProvider";
import { approximateSolarRadiation, CloudCoverInfo, EToData } from "../adjustmentMethods/EToAdjustmentMethod";
import { CodedError, ErrorCode } from "../../errors";

export default class BrightSkyWeatherProvider extends WeatherProvider {

// BrightSky is only available within Germany

	public async getWateringData( coordinates: GeoCoordinates ): Promise< ZimmermanWateringData > {
		// Zimmerman method can only use last day weather information
		const yesterday_start = moment().subtract( 1, "days" ).utc();
		const yesterday_end = moment().subtract( 1, "hours" ).utc();
		const yesterdayData = await this.getBrightSkyData( coordinates, yesterday_start.format("Y-MM-DDTHH:mm:ss"), yesterday_end.format("Y-MM-DDTHH:mm:ss") );

		const periods = Math.min( yesterdayData.length, 24 );
		// Fail if not enough data is available.
		// There will only be 23 samples on the day that daylight saving time begins.
		if ( yesterdayData.length !== 24 && yesterdayData.length !== 23 ) {
			throw new CodedError( ErrorCode.InsufficientWeatherData );
		}
		const totals = { temp: 0, humidity: 0, precip: 0 };
		for ( let index = 0; index < yesterdayData.length; index++ ) {
			totals.temp += yesterdayData[ index ].temperature;
			totals.humidity += yesterdayData[ index ].humidity;
			totals.precip += yesterdayData[ index ].precipitation;
		}

		return {
			weatherProvider: "BS",
			temp: totals.temp / yesterdayData.length,
			humidity: totals.humidity / yesterdayData.length,
			precip: totals.precip,
			raining: yesterdayData[ yesterdayData.length-1 ].precipitation > 0
		};
	}

	public async getWeatherData( coordinates: GeoCoordinates ): Promise< WeatherData > {
		const startTime = moment().startOf('day').local();
		const forecast_days = 8;
		const endTime = moment().startOf('day').add( forecast_days, "days" ).local();
		const forecastData = await this.getBrightSkyData( coordinates, startTime.format(), endTime.format() );
		forecastData.splice(-1,1);

		const dailyData = { 
			current: {
				temp: 		forecastData[0].temperature,
				humidity: 	forecastData[0].humidity,
				wind:		forecastData[0].wind,
				icon:		this.getOWMIconCode( forecastData[0].icon ),
				mintemp:	0,
				maxtemp:	0,
				precip: 	0	
			},
			daily: []
		};
		for ( let index = 0; index < forecast_days; index++ ) {
			// Walk through specified days
			// Always take a slice of daily data
			const start_index: number = 24 * index;
			const samples: any = forecastData.slice( start_index, Math.min(start_index + 24, forecastData.length ) );
			// Save values to extra variable
			const totals = { mintemp: samples[0].temperature, maxtemp: samples[0].temperature, precip: samples[0].precipitation, icon: this.getOWMIconCode( samples[0].icon ) };
			for ( let sub_index = 1; sub_index < samples.length; sub_index++ ) {
				// Walk through day starting with index 1, since data of index 0 is already saved.
				totals.mintemp = Math.min(samples[ sub_index ].temperature, totals.mintemp);
				totals.maxtemp = Math.max(samples[ sub_index ].temperature, totals.maxtemp);
				totals.precip += samples[ sub_index ].precipitation;
				totals.icon = totals.icon == "01d" ? this.getOWMIconCode( samples[ sub_index ].icon ) : "01d";
				// Treat first index differtntly, sincs this is saved to dailyData.current
				if ( index === 0) {
					if ( moment.parseZone(samples[ sub_index ].timestamp).local().isSameOrBefore( moment().local() ) ) { 
						dailyData.current.temp = samples[ sub_index ].temperature;
						dailyData.current.humidity = samples[ sub_index ].humidity;
						dailyData.current.wind = samples[ sub_index ].wind;
						dailyData.current.icon = this.getOWMIconCode( samples[ sub_index ].icon );				
					}
				}
			}
			// Save other totals to dailyData.current
			if ( index == 0) {
				dailyData.current.mintemp = totals.mintemp;
				dailyData.current.maxtemp = totals.maxtemp;
				dailyData.current.precip = totals.precip;
			}
			dailyData.daily.push( {
				temp_min: totals.mintemp,
				temp_max: totals.maxtemp,
				date: moment.parseZone(samples[12].timestamp).local().startOf('day').unix(),
				precip: totals.precip,
				icon: totals.icon
			} );
		}
		// Save dailyData.current to weatherData
		const weather: WeatherData = {
			weatherProvider: "BrightSky",
			temp: Math.floor( dailyData.current.temp ),
			humidity: Math.floor( dailyData.current.humidity ),
			wind: Math.floor( dailyData.current.wind ),
			description: "",
			icon: dailyData.current.icon,

			region: "",
			city: "",
			minTemp: Math.floor( dailyData.current.mintemp ),
			maxTemp: Math.floor( dailyData.current.maxtemp ),
			precip: dailyData.current.precip,
			forecast: []
		};
		// Save forecast data
		for ( let index = 0; index < dailyData.daily.length; index++ ) {
			weather.forecast.push( {
				temp_min: Math.floor( dailyData.daily[ index ].temp_min ),
				temp_max: Math.floor( dailyData.daily[ index ].temp_max ),
				date: dailyData.daily[ index ].date,
				icon: dailyData.daily[ index ].icon,
				description: ""
			} );
		}

		return weather;
	}

	public async getEToData( coordinates: GeoCoordinates ): Promise< EToData > {
		// The Unix epoch seconds timestamp of 24 hours ago.
		const yesterday_start = moment().subtract( 1, "days" ).utc();
		const yesterday_end = moment().subtract( 1, "hours" ).utc();
		const yesterdayData = await this.getBrightSkyData( coordinates, yesterday_start.format("Y-MM-DDTHH:mm:ss"), yesterday_end.format("Y-MM-DDTHH:mm:ss") );
		const cloudCoverInfo: CloudCoverInfo[] = yesterdayData.map( ( hour ): CloudCoverInfo => {
			return {
				startTime: moment.parseZone(hour.timestamp).local(),
				endTime: moment.parseZone(hour.timestamp).add( 1, "hours" ).local(),
				cloudCover: hour.cloud_cover / 100
			};
		} );
		let minTemp: number = undefined, maxTemp: number = undefined;
		let minHumidity: number = undefined, maxHumidity: number = undefined;
		// Skip hours where measurements don't exist to prevent result from being NaN.
		for ( const sample of yesterdayData ) {
			const temp: number = sample.temperature;
			if ( temp !== undefined ) {
				// If minTemp or maxTemp is undefined, these comparisons will yield false.
				minTemp = minTemp < temp ? minTemp : temp;
				maxTemp = maxTemp > temp ? maxTemp : temp;
			}

			const humidity: number = sample.humidity;
			if ( humidity !== undefined ) {
				// If minHumidity or maxHumidity is undefined, these comparisons will yield false.
				minHumidity = minHumidity < humidity ? minHumidity : humidity;
				maxHumidity = maxHumidity > humidity ? maxHumidity : humidity;
			}
		}
		return {
			weatherProvider: "BS",
			periodStartTime: moment.parseZone( yesterdayData[ 0 ].timestamp ).utc().unix(),
			minTemp: minTemp,
			maxTemp: maxTemp,
			minHumidity: minHumidity,
			maxHumidity: maxHumidity,
			solarRadiation: approximateSolarRadiation( cloudCoverInfo, coordinates ),
			// Assume wind speed measurements are taken at 2 meters.
			windSpeed: yesterdayData.reduce( ( sum, window ) => sum + ( window.wind || 0 ), 0) / yesterdayData.length,
			precip: yesterdayData.reduce( ( sum, window ) => sum + ( window.precipitation || 0 ), 0)
		};
	}

	private async getBrightSkyData( coordinates: GeoCoordinates, startTime: string, endTime: string ): Promise< any > {
		const Url = `https://api.brightsky.dev/weather?lat=${ coordinates[ 0 ] }&lon=${ coordinates[ 1 ] }&date=${ startTime }&last_date=${ endTime }`;

		// Perform the HTTP request to retrieve the weather data
		let bsData;
		try {
			bsData = await httpJSONRequest( Url );
		} catch ( err ) {
			console.error( "Error retrieving weather information from BrightSky:", err );
			throw new CodedError( ErrorCode.WeatherApiError );
		}

		// Indicate brightsky data could not be retrieved.
		if ( !bsData || !bsData.weather ) {
			throw new CodedError( ErrorCode.MissingWeatherField );
		}
		const weather = [];
		let temperature, dew_point, relative_humidity;
		for ( let index = 0; index < bsData.weather.length; index++ ) {
			temperature = parseFloat( bsData.weather[ index ].temperature );
			if (typeof bsData.weather[ index ].relative_humidity === 'number') {
				// In some data relative humidity is null, then derive humidity through dew point.
				relative_humidity = parseInt( bsData.weather[ index ].relative_humidity );
			} else {
				dew_point = parseFloat( bsData.weather[ index ].dew_point );
				const K2 = 17.62, K3 = 243.12;
				relative_humidity = Math.round( 100 * Math.exp( ( K2 * dew_point )  / ( K3 + dew_point ) ) / Math.exp( ( K2 * temperature ) / ( K3 + temperature ) ) );
			}
			weather.push( {
				timestamp: bsData.weather[ index ].timestamp,
				precipitation: parseFloat( bsData.weather[ index ].precipitation ) / 25.4,
				temperature: temperature * 1.8 + 32,
				humidity: relative_humidity,
				wind: parseFloat( bsData.weather[ index ].wind_speed ) * 0.62,
				icon: bsData.weather[ index ].icon,
				cloud_cover: parseInt( bsData.weather[ index ].cloud_cover )
			} );
		}
		return weather;
	}

	private getOWMIconCode(icon: string) {
		switch(icon) {
			case "partly-cloudy-night":
				return "02n";
			case "partly-cloudy-day":
				return "02d";
			case "cloudy":
				return "03d";
			case "fog":
			case "wind":
				return "50d";
			case "hail":
			case "sleet":
			case "snow":
				return "13d";
			case "rain":
				return "10d";
			case "thunderstorm":
				return "11d";
			case "clear-night":
				return "01n";
			case "clear-day":
			default:
				return "01d";
		}
	}
}
